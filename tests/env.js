process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://amrutam:amrutam@localhost:5432/amrutam_test';
process.env.RATE_LIMIT_ENABLED = 'false';
