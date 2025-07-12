// --- НАЧАЛО БЛОКА ОТЛАДКИ (САМАЯ ПЕРВАЯ ВЕЩЬ В ФАЙЛЕ) ---
// Это гарантирует, что мы увидим этот вывод, даже если есть проблемы с `require`.
console.log("\n--- ОТЛАДКА v2: ПРОВЕРКА ВХОДНЫХ ДАННЫХ ---");
console.log(`Аргумент --jobId получен: ${!!process.argv.find(a => a.startsWith('--jobId'))}`);
console.log(`Аргумент --companyId получен: ${!!process.argv.find(a => a.startsWith('--companyId'))}`);
console.log(`Секрет PROJECT_URL (для SUPABASE_URL) присутствует: ${!!process.env.SUPABASE_URL}`);
console.log(`Секрет SERVICE_KEY (для SUPABASE_SERVICE_ROLE_KEY) присутствует: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}`);
console.log(`Секрет GEMINI_API_KEY присутствует: ${!!process.env.GEMINI_API_KEY}`);
console.log(`Секрет HH_USER_AGENT присутствует: ${!!process.env.HH_USER_AGENT}`);
console.log("--- КОНЕЦ БЛОКА ОТЛАДКИ ---\n");
// --- КОНЕЦ БЛОКА ОТЛАДКИ ---

// ИЗМЕНЕНИЕ: Используем require вместо import
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');


// --- A HELPER TO PARSE COMMAND LINE ARGUMENTS ---
const getArg = (argName) => {
    const arg = process.argv.find(a => a.startsWith(`${argName}=`));
    return arg ? arg.split('=')[1] : null;
};

// --- CONSTANTS AND INITIALIZATION ---
const JOB_ID = getArg('--jobId');
const COMPANY_ID = getArg('--companyId');

const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
    GEMINI_API_KEY,
    HH_USER_AGENT
} = process.env;

if (!JOB_ID || !COMPANY_ID || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
    console.error("ОШИБКА: Не все обязательные переменные или аргументы были установлены. Скрипт будет остановлен.");
    console.error("Пожалуйста, проверьте лог отладки выше, чтобы увидеть, какое значение отсутствует (false).");
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
const HH_API_URL = 'https://api.hh.ru/vacancies';

// --- HELPER FUNCTIONS ---

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchAllVacanciesForCompany(companyId) {
    const allVacancies = [];
    let page = 0;
    while (true) {
        try {
            const response = await axios.get(HH_API_URL, {
                params: {
                    employer_id: companyId,
                    per_page: 100,
                    page: page,
                    archived: false
                },
                headers: { 'User-Agent': HH_USER_AGENT || 'analyzer-script/1.0' },
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
                competitors_count: null
            }));
            allVacancies.push(...mappedItems);

            page++;
            if (response.data.pages === page) break;
        } catch (error) {
            console.error(`Error fetching vacancies for company ${companyId}:`, error.message);
            throw new Error(`Failed to fetch vacancies from hh.ru: ${error.message}`);
        }
    }
    return allVacancies;
}

async function normalizeTitlesForVacancies(vacancies) {
    const titlesToProcess = vacancies.map(v => ({ id: v.hh_vacancy_id, title: v.raw_title }));
    const prompt = `Your task is to aggressively normalize job titles, leaving only the professional essence. Rules: 1. Remove seniority levels. 2. Remove clarifications in parentheses. 3. If there are multiple positions via slash (/), keep the first one. 4. Remove extra specializations. 5. Shorten long titles. Examples: "Монтажник РЭА и приборов" -> "Монтажник РЭА", "Токарь на оборонный завод" -> "Токарь", "Ведущий (старший) бухгалтер" -> "Бухгалтер", "Казначей/финансовый менеджер" -> "Казначей". CRITICALLY IMPORTANT: Your response must be only and exclusively a valid JSON array of objects, where each object has the format {"id": vacancy_id_number, "title": "normalized_title"}. Do not add anything extra. Here is the list: ${JSON.stringify(titlesToProcess)}`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("JSON array not found in Gemini's response.");

        const normalizedDataArray = JSON.parse(jsonMatch[0]);
        const normalizedMap = new Map(normalizedDataArray.map(item => [parseInt(item.id), item.title]));

        vacancies.forEach(v => {
            if (normalizedMap.has(v.hh_vacancy_id)) {
                v.normalized_title = normalizedMap.get(v.hh_vacancy_id);
            }
        });
    } catch (error) {
        console.error(`Error normalizing titles via Gemini:`, error.message);
        throw new Error('Error contacting the title normalization service.');
    }
}

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

    console.log(`-> Grouped into ${groupedVacancies.size} search groups.`);
    let groupIndex = 0;

    for (const vacancyGroup of groupedVacancies.values()) {
        groupIndex++;
        const representative = vacancyGroup[0];
        console.log(`--> Processing group ${groupIndex}/${groupedVacancies.size}: "${representative.normalized_title}"`);

        try {
            const response = await axios.get(HH_API_URL, {
                params: {
                    text: representative.normalized_title,
                    area: representative.area_id,
                    schedule: representative.schedule_id,
                    order_by: 'relevance',
                    per_page: 100,
                },
                headers: { 'User-Agent': HH_USER_AGENT || 'analyzer-script/1.0' },
            });

            const competitors_count = response.data.found;
            const positionMap = new Map(response.data.items.map((item, index) => [parseInt(item.id), index + 1]));

            for (const vacancy of vacancyGroup) {
                vacancy.competitors_count = competitors_count;
                vacancy.position = positionMap.get(vacancy.hh_vacancy_id) || 'Not found in top 100';
            }
        } catch (searchError) {
            console.error(`Search error for group "${representative.normalized_title}". Skipping.`);
        }
        await sleep(500);
    }
    return vacancies;
}


// --- MAIN SCRIPT EXECUTION ---
async function main() {
    console.log(`Starting analysis for job ${JOB_ID}, company ${COMPANY_ID}`);
    try {
        await supabase.from('live_analysis_jobs').update({ status: 'processing' }).eq('id', JOB_ID);

        const vacancies = await fetchAllVacanciesForCompany(COMPANY_ID);
        if (vacancies.length > 0) {
            await normalizeTitlesForVacancies(vacancies);
            await trackPositions(vacancies);
        }

        console.log("Analysis complete. Saving result...");
        const { error } = await supabase
            .from('live_analysis_jobs')
            .update({
                status: 'completed',
                result_data: { vacancies },
                completed_at: new Date().toISOString()
            })
            .eq('id', JOB_ID);

        if (error) throw error;
        console.log("Result saved successfully!");

    } catch (error) {
        console.error("A critical error occurred during the analysis:", error);
        await supabase
            .from('live_analysis_jobs')
            .update({
                status: 'failed',
                error_message: error.message,
                completed_at: new Date().toISOString()
            })
            .eq('id', JOB_ID);
        process.exit(1);
    }
}

main();