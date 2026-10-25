function evaluateAge(answer) {
  const input = answer.trim();
  let age = null;

  // Accept a numeric age, such as "32".
  if (/^\d{1,3}$/.test(input)) {
    age = Number(input);
  } else {
    // Accept DOB formats: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD.
    let day;
    let month;
    let year;
    let match;

    if ((match = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
      day = Number(match[1]);
      month = Number(match[2]);
      year = Number(match[3]);
    } else if ((match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    }

    if (year !== undefined) {
      const dob = new Date(Date.UTC(year, month - 1, day));

      const validDate =
        dob.getUTCFullYear() === year &&
        dob.getUTCMonth() === month - 1 &&
        dob.getUTCDate() === day &&
        dob.getTime() <= Date.now();

      if (validDate) {
        const today = new Date();

        age =
          today.getFullYear() -
          year -
          (today.getMonth() + 1 < month ||
          (today.getMonth() + 1 === month && today.getDate() < day)
            ? 1
            : 0);
      }
    }
  }

  if (age === null || !Number.isInteger(age) || age < 0 || age > 120) {
    return {
      outcome: "clarification",
      age: null,
      message: "Please provide your age in years or a valid DOB.",
    };
  }

  // Workbook rule: below 18 or above 40 = reject.
  if (age < 18 || age > 40) {
    return {
      outcome: "reject",
      age,
      message: "Age is outside the eligibility range.",
    };
  }

  // Workbook rule: 39–40 = manual review.
  if (age >= 39 && age <= 40) {
    return {
      outcome: "manual_review",
      age,
      message: "Age requires manual review.",
    };
  }

  // Workbook rule: 18–38 = pass.
  return {
    outcome: "pass",
    age,
    message: "Age meets the eligibility rule.",
  };
}

module.exports = { evaluateAge };
