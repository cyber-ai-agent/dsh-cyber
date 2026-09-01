import type { UiLocale } from '@dsh-cyber/contracts'

/**
 * One locale's row of a message catalog.
 *
 * `null` marks a key that is deliberately not translated for this locale yet.
 * The runtime resolver in `runtime.ts` already falls back to en-US and then
 * zh-CN for keys it cannot find, so a `null` row entry behaves exactly like the
 * key being absent — the difference is that the gap is now written down instead
 * of being invisible.
 */
export type LocaleCatalogRow = Readonly<Record<string, string | null>>

type CatalogKey<C> = { [L in keyof C]: keyof C[L] }[keyof C] & string

type ParityChecked<C> = { readonly [L in UiLocale]: { readonly [K in CatalogKey<C>]: string | null } }

/**
 * Builds a twelve-locale message catalog and enforces key parity at the type
 * level.
 *
 * `as const satisfies Record<UiLocale, Record<string, string>>` does not force
 * the locale objects to agree: a key added to one locale alone typechecks and
 * then silently falls back at runtime. This helper instead collects the union of
 * every key that appears in any locale and requires every locale to declare all
 * of them, so both a missing key and a stray extra key are compile errors.
 *
 * `null` values are stripped from the returned catalogs, which keeps runtime
 * lookup behaviour identical to a catalog that simply omitted the key.
 */
export function defineLocaleCatalogs<C extends Readonly<Record<UiLocale, LocaleCatalogRow>>>(
  catalogs: C & ParityChecked<C>,
): Record<UiLocale, Record<string, string>> {
  const resolved = {} as Record<UiLocale, Record<string, string>>
  for (const [locale, row] of Object.entries(catalogs) as Array<[UiLocale, LocaleCatalogRow]>) {
    const translated: Record<string, string> = {}
    for (const [key, value] of Object.entries(row)) if (value !== null) translated[key] = value
    resolved[locale] = translated
  }
  return resolved
}
