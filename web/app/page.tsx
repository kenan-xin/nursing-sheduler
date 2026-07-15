import { AppVersion } from "@/components/app-version";

// Foundation shell only — real screens land in later tickets (T03+).
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Nurse Scheduler</h1>
      <p className="text-muted-foreground text-sm">Frontend scaffold is up.</p>
      <AppVersion />
    </main>
  );
}
