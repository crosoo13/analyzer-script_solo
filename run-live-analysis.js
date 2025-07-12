// index.js

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- ИНИЦИАЛИЗАЦИЯ КЛИЕНТОВ ---
const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite-preview-06-17" });
const HH_API_URL = 'https://api.hh.ru/vacancies';
const USER_AGENT = process.env.HH_USER_AGENT || 'analyzer-script/1.0';
const PORT = process.env.PORT || 3000;


// --- ГЛАВНЫЙ ЭНДПОИНТ, ИМИТИРУЮЩИЙ ЛОГИКУ main() ---
app.post('/analyze-company', async (req, res) => {
    const { companyId } = req.body;
    if (!companyId) {
        return res.status(400).json({ error: 'В теле запроса должен быть указан "companyId".' });
    }

    console.log(`\n[${new Date().toISOString()}] Запущен анализ для компании: ${companyId}`);

    try {
        // --- ШАГ 1: ПОЛУЧЕНИЕ ВАКАНСИЙ С HH.RU ---
        console.log('\n--- НАЧАЛО ШАГА 1: ПОЛУЧЕНИЕ ВАКАНСИЙ ---');
        const vacancies = await fetchAllVacanciesForCompany(companyId);
        if (vacancies.length === 0) {
            console.log('-> Активных вакансий не найдено.');
            return res.json({ message: 'Активных вакансий для данной компании не найдено.', vacancies: [] });
        }
        console.log(`-> С HH.ru получено ${vacancies.length} активных вакансий.`);

        // --- ШАГ 2: НОРМАЛИЗАЦИЯ НАЗВАНИЙ ЧЕРЕЗ AI ---
        console.log('\n--- НАЧАЛО ШАГА 2: НОРМАЛИЗАЦИЯ НАЗВАНИЙ ---');
        await normalizeTitlesForVacancies(vacancies);

        // --- ШАГ 3: ОПТИМИЗИРОВАННОЕ ОТСЛЕЖИВАНИЕ ПОЗИЦИЙ ---
        console.log('\n--- НАЧАЛО ШАГА 3: ОТСЛЕЖИВАНИЕ ПОЗИЦИЙ ---');
        const results = await trackPositions(vacancies);

        console.log('\nАнализ успешно завершен! Отправка ответа...');
        res.json({
            companyId: companyId,
            totalVacancies: results.length,
            vacancies: results
        });

    } catch (error) {
        console.error(`\n!!! КРИТИЧЕСКАЯ ОШИБКА при анализе компании ${companyId}:`, error.message);
        res.status(500).json({ error: 'Произошла внутренняя ошибка сервера.', details: error.message });
    }
});


// --- АДАПТИРОВАННЫЕ ФУНКЦИИ ИЗ ОРИГИНАЛЬНОГО СКРИПТА ---

/**
 * Загружает все страницы с активными вакансиями для одной компании.
 */
async function fetchAllVacanciesForCompany(companyId) {
    let allVacancies = [];
    let page = 0;
    while (true) {
        const config = {
            method: 'get',
            url: HH_API_URL,
            params: { employer_id: companyId, per_page: 100, page, archived: false },
            headers: { 'User-Agent': USER_AGENT },
        };
        try {
            const response = await makeRequestWithRetries(config);
            const items = response.data.items;
            if (items.length === 0) break;

            const mappedItems = items.map(v => ({
                hh_vacancy_id: parseInt(v.id),
                raw_title: v.name,
                normalized_title: null,
                area_name: v.area.name,
                area_id: parseInt(v.area.id),
                schedule_id: v.schedule.id,
                url: v.alternate_url,
                position: null,
                competitors_count: null
            }));
            allVacancies = allVacancies.concat(mappedItems);

            page++;
            if (response.data.pages === page) break;
        } catch (error) {
            throw new Error(`Не удалось получить вакансии с hh.ru после всех попыток.`);
        }
    }
    return allVacancies;
}

/**
 * Отправляет названия вакансий в Gemini для нормализации.
 */
async function normalizeTitlesForVacancies(vacancies) {
    console.log(`Найдено ${vacancies.length} вакансий для нормализации.`);
    const titlesToProcess = vacancies.map(v => ({ id: v.hh_vacancy_id, title: v.raw_title }));
    const prompt = `Твоя задача - максимально агрессивно нормализовать названия вакансий, оставив только самую суть профессии. Правила: 1. Удаляй уровни должностей. 2. Удаляй уточнения в скобках. 3. Если несколько должностей через слэш (/), оставляй первую. 4. Убирай лишние специализации. 5. Сокращай длинные названия. Примеры: "Монтажник РЭА и приборов" -> "Монтажник РЭА", "Токарь на оборонный завод" -> "Токарь", "Ведущий (старший) бухгалтер" -> "Бухгалтер", "Казначей/финансовый менеджер" -> "Казначей". КРАЙНЕ ВАЖНО: Твой ответ должен быть только и исключительно валидным JSON-массивом объектов, где каждый объект имеет вид {"id": id_вакансии_числом, "title": "нормализованное_название"}. Не добавляй ничего лишнего. Вот список: ${JSON.stringify(titlesToProcess)}`;

    let text = '';
    try {
        const result = await geminiModel.generateContent(prompt);
        text = result.response.text();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("В ответе от Gemini не найден JSON-массив.");

        const normalizedDataArray = JSON.parse(jsonMatch[0]);
        const normalizedMap = new Map(normalizedDataArray.map(item => [parseInt(item.id), item.title]));

        vacancies.forEach(v => {
            if (normalizedMap.has(v.hh_vacancy_id)) {
                v.normalized_title = normalizedMap.get(v.hh_vacancy_id);
            }
        });
        console.log(`-> Gemini успешно обработал ${normalizedDataArray.length} названий.`);
    } catch (error) {
        console.error(`\n!!! Ошибка при обработке с Gemini: ${error.message}`);
        console.error("--- НАЧАЛО ПРОБЛЕМНОГО ОТВЕТА ОТ GEMINI ---\n", text, "\n--- КОНЕЦ ПРОБЛЕМНОГО ОТВЕТА ---");
        throw new Error('Ошибка при обращении к сервису нормализации названий.');
    }
}

/**
 * Отслеживает позиции вакансий, группируя запросы для повышения эффективности.
 */
async function trackPositions(vacancies) {
    const groupedVacancies = new Map();
    for (const vacancy of vacancies) {
        if (!vacancy.normalized_title) continue;
        const groupKey = `${vacancy.normalized_title}_${vacancy.area_id}_${vacancy.schedule_id}`;
        if (!groupedVacancies.has(groupKey)) groupedVacancies.set(groupKey, []);
        groupedVacancies.get(groupKey).push(vacancy);
    }

    console.log(`-> Сформировано ${groupedVacancies.size} уникальных поисковых групп.`);

    let groupIndex = 0;
    for (const vacancyGroup of groupedVacancies.values()) {
        groupIndex++;
        const representative = vacancyGroup[0];
        console.log(`\n[Группа ${groupIndex}/${groupedVacancies.size}] Поиск для "${representative.normalized_title}" (вакансий в группе: ${vacancyGroup.length})`);

        const axiosConfig = {
            method: 'get', url: HH_API_URL,
            params: { text: representative.normalized_title, area: representative.area_id, schedule: representative.schedule_id, order_by: 'relevance', per_page: 100 },
            headers: { 'User-Agent': USER_AGENT },
        };

        try {
            const response = await makeRequestWithRetries(axiosConfig);
            const competitors_count = response.data.found;
            console.log(` -> Найдено конкурентов: ${competitors_count}`);

            const positionMap = new Map(response.data.items.map((item, index) => [parseInt(item.id), index + 1]));

            for (const vacancy of vacancyGroup) {
                const position = positionMap.get(vacancy.hh_vacancy_id) || 'Не найдено в топ-100';
                vacancy.position = position;
                vacancy.competitors_count = competitors_count;
                console.log(`   - Вакансия ${vacancy.hh_vacancy_id}: Позиция ${position}`);
            }
        } catch (searchError) {
             console.error(` -> !!! Ошибка поиска для группы "${representative.normalized_title}". Пропускаем группу.`);
             for (const vacancy of vacancyGroup) {
                vacancy.position = 'Ошибка поиска';
                vacancy.competitors_count = 0;
            }
        }

        if (groupIndex < groupedVacancies.size) {
            await sleep(500);
        }
    }
    return vacancies;
}


// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ИЗ ОРИГИНАЛЬНОГО СКРИПТА ---

/**
 * Выполняет axios-запрос с несколькими попытками в случае сбоя.
 */
async function makeRequestWithRetries(axiosConfig, retries = 5, baseDelay = 1000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await axios(axiosConfig);
        } catch (error) {
            const status = error.response ? error.response.status : 'N/A';
            const isRetryable = error.response && [403, 429, 500, 502, 503, 504].includes(status);

            if (isRetryable && attempt < retries) {
                const delay = baseDelay * (2 ** (attempt - 1));
                console.warn(` -> Попытка ${attempt} не удалась (статус ${status}). Повтор через ${delay / 1000} сек...`);
                await sleep(delay);
            } else {
                console.error(` -> Финальная ошибка после ${attempt} попыток (статус ${status}).`, error.message);
                throw error;
            }
        }
    }
}

/**
 * Функция-пауза.
 */
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }


// --- ЗАПУСК СЕРВЕРА ---
app.listen(PORT, () => {
    console.log(`Сервер анализа запущен и слушает порт ${PORT}`);
    console.log(`Отправляйте POST запросы на http://localhost:${PORT}/analyze-company`);
});