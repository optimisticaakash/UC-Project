export default function CandidateSignInUnavailable() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <section className="rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-neutral-500">Candidate access</p>
        <h1 className="mt-3 text-2xl font-bold text-neutral-950">Candidate sign-in is unavailable</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-600">
          This project currently has no candidate login or session API. No sign-in has been performed. Please contact the Urban Company team for access.
        </p>
        <a className="mt-6 inline-block rounded-lg bg-black px-4 py-2.5 text-sm font-semibold text-white" href="/">Return to interview portal</a>
      </section>
    </main>
  );
}
