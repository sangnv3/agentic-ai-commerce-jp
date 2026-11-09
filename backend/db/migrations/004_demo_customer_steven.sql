-- The demo sample customer is now "Steven" (was 田中 健太). Rename demo/dev customers created from the old template
-- so the agent greets them as Steven too. Real (Entra) customers are not touched.
UPDATE users
   SET display_name = 'Steven', family_name = 'Steven', email = 'steven@example.co.jp', updated_at = now()
 WHERE auth_provider IN ('demo', 'dev') AND family_name = '田中';
