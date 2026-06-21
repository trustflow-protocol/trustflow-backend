import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { UserProfileEntity } from '../user-profile/user-profile.entity';

/**
 * TypeORM Database Configuration
 * Configures PostgreSQL connection for TrustFlow backend
 */
export const databaseConfig: TypeOrmModuleOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'trustflow',
  password: process.env.DB_PASSWORD || 'trustflow',
  database: process.env.DB_NAME || 'trustflow_db',
  entities: [UserProfileEntity],
  synchronize: process.env.NODE_ENV !== 'production', // Auto-sync schema in dev
  logging: process.env.NODE_ENV === 'development',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Connection pool settings
  extra: {
    max: 20, // Maximum number of connections in pool
    min: 5, // Minimum number of connections in pool
    idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
    connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
  },
};
