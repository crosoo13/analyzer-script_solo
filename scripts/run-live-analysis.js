// Используем синтаксис 'require', который доказал свою работоспособность в вашем окружении
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Вспомогательная функция для получения именованных аргументов из командной строки.
 * @param {string} argName - Имя аргумента (например, '--jobId').
 * @returns {string|null} - Значение аргумента или null, если он не найден.
 */
const getArg = (argName) => {
    const arg = process.argv.find(a => a.startsWith(`${argName}=`));
    return arg ? arg.split('=')[1] : null;
};

// --- КОНСТАНТЫ И ИНИЦИАЛИЗАЦИЯ ---
const JOB_ID = getArg('--jobId');
const COMPANY_ID = getArg('--companyId');

// Получаем переменные окружения, переданные из GitHub Actions
const {
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
    GEMINI_API_KEY,
    HH_USER_AGENT
} = process.env;

// Критически важная проверка: если чего-то не хватает, скрипт не запустится
if (!JOB_ID || !COMPANY_ID || !SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GEMINI_API_KEY) {
    console.error("ОШИБКА: Не все обязательные переменные или аргументы были установлены. Выполнение остановлено.");
    if (!JOB_ID) console.error("- Аргумент --jobId отсутствует.");
    if (!COMPANY_ID) console.error("- Аргумент --companyId отсутствует.");
    if (!SUPABASE_URL) console.error("- Секрет SUPABASE_URL отсутствует.");
    if (!SUPABASE_SERVICE_KEY) console.error("- Секрет SUPABASE_SERVICE_KEY отсутствует.");
    if (!GEMINI_API_KEY) console.error("- Секрет GEMINI_API_KEY отсутствует.");
    process.exit(1);
}

// Инициализация клиентов для работы с API
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const HH_API_URL = 'https://api.hh.ru/vacancies';
const USER_AGENT = HH_USER_AGENT || 'analyzer-script/1.0';

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Загружает все активные вакансии для одной компании с hh.ru.
 */
async function fetchAllVacanciesForCompany(companyId) {
    const allVacancies = [];
    let page = 0;
    while (true) {
        try {
            const response = await axios.get(HH_API_URL, {
                params: { employer_id: companyId, per_page: 100, page: page, archived: false },
                headers: { 'User-Agent': USER_AGENT },
            });
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
                competitors_count: null,
                published_at: v.published_at // <-- КЛЮЧЕВОЕ ДОБАВЛЕНИЕ: ЗАБИРАЕМ ДАТУ ПУБЛИКАЦИИ
            }));
            allVacancies.push(...mappedItems);

            page++;
            if (response.data.pages === page) break;
        } catch (error) {
            console.error(`Ошибка при получении вакансий для компании ${companyId}:`, error.message);
            throw new Error(`Не удалось получить вакансии с hh.ru: ${error.message}`);
        }
    }
    return allVacancies;
}

/**
 * Отправляет "сырые" названия вакансий в Gemini для их нормализации.
 */
async function normalizeTitlesForVacancies(vacancies) {
    const titlesToProcess = vacancies.map(v => ({ id: v.hh_vacancy_id, title: v.raw_title }));
    const prompt = `Твоя задача - максимально агрессивно нормализовать названия вакансий, оставив только самую суть профессии. Правила: 1. Удаляй уровни должностей. 2. Удаляй уточнения в скобках. 3. Если несколько должностей через слэш (/), оставляй первую. 4. Убирай лишние специализации. 5. Сокращай длинные названия. Примеры: "Монтажник РЭА и приборов" -> "Монтажник РЭА", "Токарь на оборонный завод" -> "Токарь", "Ведущий (старший) бухгалтер" -> "Бухгалтер", "Казначей/финансовый менеджер" -> "Казначей". КРАЙНЕ ВАЖНО: Твой ответ должен быть только и исключительно валидным JSON-массивом объектов, где каждый объект имеет вид {"id": vacancy_id_number, "title": "normalized_title"}. Не добавляй ничего лишнего. Вот список: ${JSON.stringify(titlesToProcess)}`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("В ответе от Gemini не найден JSON-массив.");

        const normalizedDataArray = JSON.parse(jsonMatch[0]);
        const normalizedMap = new Map(normalizedDataArray.map(item => [parseInt(item.id), item.title]));

        vacancies.forEach(v => {
            if (normalizedMap.has(v.hh_vacancy_id)) {
                v.normalized_title = normalizedMap.get(v.hh_vacancy_id);
            }
        });
    } catch (error) {
        console.error(`Ошибка нормализации названий через Gemini:`, error.message);
        throw new Error('Ошибка при обращении к сервису нормализации названий.');
    }
}

/**
 * Определяет позицию в поиске и число конкурентов для каждой вакансии.
 */
async function trackPositions(vacancies) {
    const groupedVacancies = new Map();
    for (const vacancy of vacancies) {
        if (!vacancy.normalized_title) continue;
        const groupKey = `${vacancy.normalized_title}_${vacancy.area_id}_${vacancy.schedule_id}`;
        if (!groupedVacancies.has(groupKey)) {
            groupedVacancies.set(groupKey, []);
        }
        groupedVacancies.get(groupKey).push(vacancy);
    }

    console.log(`-> Сгруппировано в ${groupedVacancies.size} поисковых групп.`);
    let groupIndex = 0;

    for (const vacancyGroup of groupedVacancies.values()) {
        groupIndex++;
        const representative = vacancyGroup[0];
        console.log(`--> Обработка группы ${groupIndex}/${groupedVacancies.size}: "${representative.normalized_title}"`);

        try {
            const response = await axios.get(HH_API_URL, {
                params: { text: representative.normalized_title, area: representative.area_id, schedule: representative.schedule_id, order_by: 'relevance', per_page: 100 },
                headers: { 'User-Agent': USER_AGENT },
            });

            const competitors_count = response.data.found;
            const positionMap = new Map(response.data.items.map((item, index) => [parseInt(item.id), index + 1]));

            for (const vacancy of vacancyGroup) {
                vacancy.competitors_count = competitors_count;
                vacancy.position = positionMap.get(vacancy.hh_vacancy_id) || 'Не найдено в топ 100';
            }
        } catch (searchError) {
            console.error(`Ошибка поиска для группы "${representative.normalized_title}". Пропускаем.`);
        }
        await sleep(500);
    }
    return vacancies;
}


/**
 * Главная функция, которая управляет всем процессом анализа.
 */
async function main() {
    console.log(`Запуск анализа для задачи ${JOB_ID}, компания ${COMPANY_ID}`);
    try {
        await supabase.from('live_analysis_jobs').update({ status: 'processing' }).eq('id', JOB_ID);

        const vacancies = await fetchAllVacanciesForCompany(COMPANY_ID);
        if (vacancies.length > 0) {
            console.log(`Найдено ${vacancies.length} активных вакансий. Начинаю анализ...`);
            await normalizeTitlesForVacancies(vacancies);
            await trackPositions(vacancies);
        } else {
            console.log("У компании нет активных вакансий. Анализ завершен.");
        }

        console.log("Анализ завершен. Сохранение результата...");
        const { error } = await supabase
            .from('live_analysis_jobs')
            .update({ status: 'completed', result_data: { vacancies }, completed_at: new Date().toISOString() })
            .eq('id', JOB_ID);

        if (error) throw error;
        console.log("Результат успешно сохранен!");

    } catch (error) {
        console.error("Критическая ошибка во время анализа:", error);
        await supabase
            .from('live_analysis_jobs')
            .update({ status: 'failed', error_message: error.message, completed_at: new Date().toISOString() })
            .eq('id', JOB_ID);
        process.exit(1);
    }
}

// Запускаем главную функцию
main();