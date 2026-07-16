# Icon convention

The project uses **react-icons Font Awesome 6** (`react-icons/fa6`). This replaces
the Lucide default that `shadcn init` (T02) recorded in `components.json`.

## Rules

- Import every icon from the barrel `@/components/icons`, never from
  `lucide-react` directly.
- Add new icons by re-exporting them from `web/components/icons.tsx`.
- `lucide-react` is present in `package.json` only because the manifest is frozen
  for this batch. Do **not** import it. The design-system vitest test
  (`app/design-system.test.ts`) fails the build if any source file does.

## Why not the `components.json` `iconLibrary` field?

shadcn's `iconLibrary` only accepts `lucide` or `radix` — there is no
`react-icons` value. The field is therefore left as-is and the CLI is not used to
generate icon-bearing components. Restyled shadcn/Base UI components are
hand-authored against the design tokens instead. If you ever run `shadcn add`,
rewrite any generated `lucide-react` import to an icon re-exported from
`@/components/icons`.
