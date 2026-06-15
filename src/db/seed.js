require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./index');

async function seed() {
  const adminPass = await bcrypt.hash('Admin@LKL2024', 10);
  const analystPass = await bcrypt.hash('Analista@LKL2024', 10);

  await db.query(`
    INSERT INTO users (name, email, password_hash, role) VALUES
      ('Administrador LKL', 'admin@lklgrafica.com.br', $1, 'admin'),
      ('Analista LKL', 'analista@lklgrafica.com.br', $2, 'analyst')
    ON CONFLICT (email) DO NOTHING
  `, [adminPass, analystPass]);

  console.log('✅ Usuários padrão criados.');
  console.log('   Admin: admin@lklgrafica.com.br / Admin@LKL2024');
  console.log('   Analista: analista@lklgrafica.com.br / Analista@LKL2024');
  console.log('   ⚠️  Altere as senhas após o primeiro login!');
  process.exit();
}

seed().catch((e) => { console.error(e); process.exit(1); });
