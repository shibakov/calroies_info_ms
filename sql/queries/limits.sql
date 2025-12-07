SELECT
  	'01_limit' as type,
    MAX(CASE WHEN feature_key='kcal_per_day'      THEN value_num END) AS kcal,
    MAX(CASE WHEN feature_key='protein_g_per_day' THEN value_num END) AS protein,
    MAX(CASE WHEN feature_key='fat_g_per_day'     THEN value_num END) AS fat,
    MAX(CASE WHEN feature_key='carbs_g_per_day'   THEN value_num END) AS carbs
FROM personal.feature_value
;