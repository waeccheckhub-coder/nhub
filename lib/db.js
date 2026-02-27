import { Pool } from 'pg';

let conn;

if (!conn) {
  conn = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false // Required for Neon
    }
  });
}

export default conn;
