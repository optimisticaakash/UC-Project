export function updateTranscriptState(previous, role, fullText) {
  const copy = [...previous];
  const last = copy[copy.length - 1];

  if (last?.role === role) {
    copy[copy.length - 1] = {
      role,
      text: fullText,
    };
  } else {
    copy.push({ role, text: fullText });
  }

  return copy;
}
