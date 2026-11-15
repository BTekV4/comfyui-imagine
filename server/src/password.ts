/**
 * The login password's scrypt record: `{ "salt": …, "hash": … }` in
 * base64url, the format DSH's login form wrote and the studio still reads.
 *
 * The settings page writes it and the login checks against it; until
 * 2026-10-25 each of the two files spelled the format out on its own.
 * @module password
 */
import { message } from './messages.ts'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { writeFileAtomic } from '../vendor/atomic-write/index.ts'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>

/** One parsed record. */
export interface PasswordRecord {
  readonly salt: Buffer
  readonly hash: Buffer
}

/**
 * Hash a new password and write its record.
 *
 * Atomic: a half-written record would lock everyone out.
 * @param file - the password file.
 * @param password - the new password, already checked by the caller.
 */
export async function savePassword(file: string, password: string): Promise<void> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 32)
  await writeFileAtomic(file, `${JSON.stringify({ salt: salt.toString('base64url'), hash: hash.toString('base64url') })}\n`, { mode: 0o600 })
}

/**
 * Read a record from the file's text.
 * @param text - the file's content.
 * @throws when it is not a record.
 */
export function parsePasswordRecord(text: string): PasswordRecord {
  const { salt, hash } = JSON.parse(text) as { salt?: unknown; hash?: unknown }
  if (typeof salt !== 'string' || typeof hash !== 'string') throw new Error(message('password.badRecord'))
  return { salt: Buffer.from(salt, 'base64url'), hash: Buffer.from(hash, 'base64url') }
}

/**
 * Whether a candidate matches a record, compared in constant time.
 * @param candidate - what the user typed.
 * @param record - the stored record.
 */
export async function verifyPassword(candidate: string, record: PasswordRecord): Promise<boolean> {
  const actual = await scryptAsync(candidate, record.salt, record.hash.length)
  return timingSafeEqual(actual, record.hash)
}
