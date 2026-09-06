/**
 * auth ユーザーのパスワードをリセット
 * 使い方: node reset_password.js <email> <new_password> [env_file_path]
 *
 * DB接続情報は以下の順で読み込む:
 *   1. 引数で指定した .env ファイル
 *   2. ../vgt-vegetrade-auth-api/.env
 *   3. 環境変数 (DB_HOST, DB_NAME, DB_USER, DB_PASSWORD)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

function promptPassword(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function loadEnv(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
    console.log(`[設定] .env 読込: ${filePath}`);
  } catch {}
}

// .env を探して読み込む
const [,, email, envArg] = process.argv;

if (!email) {
  console.error('使い方: node reset_password.js <email> [.env_path]');
  process.exit(1);
}

if (envArg) {
  loadEnv(envArg);
} else {
  loadEnv(path.join(__dirname, '..', 'vgt-vegetrade-auth-api', '.env'));
  loadEnv(path.join(__dirname, '.env'));
}

const dbConfig = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || '',
  user:     process.env.DB_USER     || '',
  password: process.env.DB_PASSWORD || '',
  ssl: (process.env.DB_SSLMODE || 'require') === 'disable' ? false : { rejectUnauthorized: true },
};

if (!dbConfig.database || !dbConfig.user) {
  console.error('エラー: DB_HOST / DB_NAME / DB_USER / DB_PASSWORD が未設定です。');
  console.error('  → ../vgt-vegetrade-auth-api/.env に記載するか、環境変数をセットしてください。');
  process.exit(1);
}

(async () => {
  const newPassword = await promptPassword('新しいパスワード: ');
  if (!newPassword) {
    console.error('エラー: パスワードが入力されていません。');
    process.exit(1);
  }
  const hashed = await bcrypt.hash(newPassword, 12);
  const client = new Client(dbConfig);

  try {
    await client.connect();
    const res = await client.query(
      `UPDATE public.user_accounts
         SET encrypted_password = $1, updated_at = NOW()
       WHERE lower(email) = $2`,
      [hashed, email.toLowerCase()]
    );
    if (res.rowCount === 0) {
      console.error(`エラー: '${email}' が見つかりません。`);
      process.exit(1);
    }
    console.log(`完了: ${email} のパスワードを変更しました。`);
  } catch (err) {
    console.error('DB エラー:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
