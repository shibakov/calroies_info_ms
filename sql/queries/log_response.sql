WITH 
-- === 1) ПОСЛЕДНЯЯ МЕТКА ВРЕМЕНИ ===
last_insert_moment AS (
    SELECT MAX(created_at) - interval '60 minutes' AS threshold
    FROM personal.food_log
),

-- === 2) ФАКТЫ ЗА ДЕНЬ (КБЖУ каждого продукта) ===
fact_calories_today AS (
    SELECT
        fl.meal_type,
        fl.product,
        fl.quantity_g,
        fl.created_at_am,
        CASE WHEN fl.created_at >= (SELECT threshold FROM last_insert_moment) 
             THEN 1 ELSE 0 END AS last_meal_flag,
        ROUND(fd.kcal_100    * fl.quantity_g / 100.0, 2) AS kcal_fact,
        ROUND(fd.protein_100 * fl.quantity_g / 100.0, 2) AS protein_fact,
        ROUND(fd.fat_100     * fl.quantity_g / 100.0, 2) AS fat_fact,
        ROUND(fd.carbs_100   * fl.quantity_g / 100.0, 2) AS carbs_fact
    FROM personal.food_log fl
    LEFT JOIN personal.food_dict fd USING (product)
    WHERE fl.created_at_am::date = CURRENT_DATE
),

-- === 3) ТОП-3 по категориям ===
top_products AS (
    (SELECT 'protein top' AS category, product, quantity_g, protein_fact AS macro_fact
     FROM fact_calories_today ORDER BY protein_fact DESC LIMIT 3)
    UNION ALL
    (SELECT 'fat top', product, quantity_g, fat_fact
     FROM fact_calories_today ORDER BY fat_fact DESC LIMIT 3)
    UNION ALL
    (SELECT 'carbs top', product, quantity_g, carbs_fact
     FROM fact_calories_today ORDER BY carbs_fact DESC LIMIT 3)
    UNION ALL
    (SELECT 'kcal top', product, quantity_g, kcal_fact
     FROM fact_calories_today ORDER BY kcal_fact DESC LIMIT 3)
),

-- === 4) ИТОГИ ДНЯ ===
totals AS (
    SELECT
        ROUND(COALESCE(SUM(kcal_fact),0),2)    AS kcal,
        ROUND(COALESCE(SUM(protein_fact),0),2) AS protein,
        ROUND(COALESCE(SUM(fat_fact),0),2)     AS fat,
        ROUND(COALESCE(SUM(carbs_fact),0),2)   AS carbs
    FROM fact_calories_today
),

-- === 5) ЛИМИТЫ (КБЖУ) ===
limits AS (
    SELECT
        CURRENT_TIMESTAMP + INTERVAL '4 hours'                 AS date_time,
        ROUND(MAX(CASE WHEN feature_key='kcal_per_day'      THEN value_num END),2) AS kcal,
        ROUND(MAX(CASE WHEN feature_key='protein_g_per_day' THEN value_num END),2) AS protein,
        ROUND(MAX(CASE WHEN feature_key='fat_g_per_day'     THEN value_num END),2) AS fat,
        ROUND(MAX(CASE WHEN feature_key='carbs_g_per_day'   THEN value_num END),2) AS carbs
    FROM personal.feature_value
),

-- === 6) ПОСЛЕДНИЙ ПРИЁМ ПИЩИ (СПИСОК ПРОДУКТОВ) ===
last_meal_rows AS (
    SELECT
        created_at_am,
        product,
        kcal_fact,
        protein_fact,
        fat_fact,
        carbs_fact
    FROM fact_calories_today
    WHERE last_meal_flag = 1
),

last_meal_meta AS (
    SELECT 
        MIN(created_at_am) AS meal_time  -- если за последний час несколько продуктов
    FROM last_meal_rows
),

last_meal_text AS (
    SELECT
        string_agg(
            '• ' || product || ' — ' ||
            kcal_fact::text    || ' ккал / ' ||
            protein_fact::text || ' Б / '    ||
            fat_fact::text     || ' Ж / '    ||
            carbs_fact::text   || ' У',
            E'\n'
        ) AS text
    FROM last_meal_rows
),

-- === 7) ТОПЫ КАК ТЕКСТ ===
tops_text AS (
    SELECT string_agg(txt, E'\n\n') AS text
    FROM (
        SELECT 
            CASE 
                WHEN category = 'protein top' THEN '🥩 Топ по белку'
                WHEN category = 'fat top'     THEN '🥑 Топ по жирам'
                WHEN category = 'carbs top'   THEN '🍚 Топ по углеводам'
                WHEN category = 'kcal top'    THEN '🔥 Топ по калорийности'
            END
            ||
            E'\n' ||
            string_agg(
                CASE rn 
                    WHEN 1 THEN '1️⃣ '
                    WHEN 2 THEN '2️⃣ '
                    WHEN 3 THEN '3️⃣ '
                END
                || product || ' — ' || macro_fact::text,
                E'\n'
            ) AS txt
        FROM (
            SELECT 
                category,
                product,
                macro_fact,
                ROW_NUMBER() OVER (PARTITION BY category ORDER BY macro_fact DESC) AS rn
            FROM top_products
        ) ranked
        GROUP BY category
        ORDER BY 
            CASE 
                WHEN category = 'protein top' THEN 1
                WHEN category = 'fat top'     THEN 2
                WHEN category = 'carbs top'   THEN 3
                WHEN category = 'kcal top'    THEN 4
            END
    ) t
)

-- === 8) ФИНАЛЬНЫЙ ОТЧЁТ ===
SELECT
    '🎯 Баланс дня [' ||
    to_char(l.date_time, 'DD.MM.YYYY, HH24:MI') || ']' || E'\n\n' ||

    '🔥 Калории: ' || t.kcal::text    || ' / ' || l.kcal::text    ||
    ' → осталось ' || (l.kcal - t.kcal)::text || E'\n' ||

    '💪 Белки: '   || t.protein::text || ' / ' || l.protein::text ||
    ' (' || (t.protein - l.protein)::text || ')' || E'\n' ||

    '🥑 Жиры: '    || t.fat::text     || ' / ' || l.fat::text     ||
    ' (' || (t.fat - l.fat)::text || ')' || E'\n' ||

    '🍚 Углеводы: '|| t.carbs::text   || ' / ' || l.carbs::text   ||
    ' (' || (t.carbs - l.carbs)::text || ')' || E'\n\n' ||

    '🍽 Последний приём (' ||
    COALESCE(to_char(m.meal_time, 'HH24:MI'), '--:--') || ')' || E'\n' ||
    COALESCE(lm.text, 'нет данных за последний час') || E'\n\n' ||

    '🥇 Топ-3 продуктов по категориям' || E'\n' ||
    COALESCE(tp.text, 'нет данных')

AS text_report
FROM totals t
CROSS JOIN limits l
LEFT JOIN last_meal_meta  m  ON TRUE
LEFT JOIN last_meal_text  lm ON TRUE
LEFT JOIN tops_text       tp ON TRUE;
