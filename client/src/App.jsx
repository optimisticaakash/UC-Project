import GeminiVoicePrototype from "./GeminiVoicePrototype";

export default function App() {
  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-950">
      <header className="w-full border-b border-neutral-200 bg-white">
        <div className="flex w-full items-center justify-between px-6 py-4 sm:px-10 lg:px-12">
          <div className="flex items-center gap-3">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-black text-lg font-extrabold text-white">
              UC
            </div>

            <div>
              <h2 className="text-base font-bold tracking-tight">
                Urban Company
              </h2>
              <p className="mt-0.5 text-xs text-neutral-500">
                Professional Skill Assessment
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 rounded-full border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600">
            <span className="size-2 rounded-full bg-black" />
            Interview Portal
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-14">
        <div className="mb-7">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-neutral-500">
            Salon Professional Screening
          </p>

          <h1 className="mt-4 max-w-2xl text-3xl font-bold leading-tight tracking-tight sm:text-5xl">
            Your skills.
            <br className="hidden sm:block" /> Your experience.
          </h1>

          <p className="mt-4 max-w-2xl text-sm leading-7 text-neutral-600 sm:text-base">
            Welcome to your professional assessment. Is interview mein hum aapke
            experience, communication aur customer-handling skills ko samjhenge.
          </p>
        </div>

        <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
          <GeminiVoicePrototype />
        </section>
      </main>
    </div>
  );
}
