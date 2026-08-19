export class PersistenceError extends Error {
  override readonly name: string = 'PersistenceError'
}

export class DatabaseCorruptError extends PersistenceError {
  override readonly name: string = 'DatabaseCorruptError'

  constructor(
    message: string,
    readonly databasePath: string,
    readonly preservedCopyPath?: string,
  ) {
    super(message)
  }
}

export class DatabaseSchemaError extends PersistenceError {
  override readonly name: string = 'DatabaseSchemaError'
}

export class SecretPersistenceError extends PersistenceError {
  override readonly name: string = 'SecretPersistenceError'
}

export class EntityNotFoundError extends PersistenceError {
  override readonly name: string = 'EntityNotFoundError'
}
