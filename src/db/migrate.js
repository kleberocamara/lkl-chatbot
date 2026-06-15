require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./index');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '../../sql/schema.sql'), 'utf8');
  try {
    await db.query(sql);
    console.log('✅ Migração concluída com sucesso.');
  } catch (err) {
    console.error('❌ Erro na migração:', err.message);
  } finally {
    process.exit();
  }
}

migrate();
