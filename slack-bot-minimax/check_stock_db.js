const { Client } = require('pg');
const c = new Client({
  host: 'pg-vgt-restore-20260601.postgres.database.azure.com',
  port: 5432, database: 'stock', user: 'vgtadmin',
  password: 'VgYLW.-Mc53_c.MCyk8GEd7nPS9_',
  ssl: { rejectUnauthorized: false }
});

c.connect().then(async () => {
  // 1. user/auth 関連テーブル一覧
  const t = await c.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE '%user%' OR table_name LIKE '%auth%') ORDER BY table_name"
  );
  console.log('User関連テーブル:', t.rows.map(r => r.table_name).join(', ') || '(なし)');

  // 2. Django migrations 件数
  try {
    const m = await c.query('SELECT COUNT(*) as cnt FROM public.django_migrations');
    console.log('マイグレーション件数:', m.rows[0].cnt);
  } catch(e) { console.log('migrations テーブルなし:', e.message); }

  // 3. demo@vegetrade.jp の存在確認
  try {
    const u = await c.query("SELECT id, email, is_active FROM public.main_system_customuser WHERE email='demo@vegetrade.jp'");
    console.log('ローカルユーザー:', u.rows.length ? JSON.stringify(u.rows[0]) : '存在しない');
  } catch(e) { console.log('ユーザーテーブルエラー:', e.message); }

  // 4. VT_AUTH_APIが何に設定されているかを確認するため、auth_user も確認
  try {
    const a = await c.query("SELECT COUNT(*) as cnt FROM public.auth_user");
    console.log('auth_user件数:', a.rows[0].cnt);
  } catch(e) { console.log('auth_user なし'); }

  await c.end();
}).catch(e => console.error('DB接続エラー:', e.message));
