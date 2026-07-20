This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## End-to-end tests

```bash
pnpm test:e2e          # required release gate — deterministic, bounded workers
pnpm test:e2e:stress   # fixed high-parallelism lane (32 workers)
```

`test:e2e` builds a production bundle and runs Playwright with a **bounded,
deterministic** worker count (`min(floor(cpus/2), 8)`). Playwright's built-in
default scales unbounded with the host, which lets the suite pass on a laptop
yet fail under CPU starvation on a large CI runner; the cap removes that
ambiguity. Override the count with `PLAYWRIGHT_WORKERS=<n>` (or the `--workers`
flag) for ad-hoc runs. `test:e2e:stress` pins a fixed **32 workers** to exercise
the high-parallelism path — always well above the bounded release default, but
not a guaranteed oversubscription: whether 32 workers exceed a host's capacity
depends on its logical-CPU count and load (on a host with 32 or more logical
cores it runs at or below one worker per core). It is **not** the release gate.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
