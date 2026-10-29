/** Cliente Redis para comandos (HSET, HGETALL, PUBLISH...). */
export const REDIS = Symbol('REDIS');
/** Conexión dedicada a SUBSCRIBE/PSUBSCRIBE (una por proceso). */
export const REDIS_SUB = Symbol('REDIS_SUB');
