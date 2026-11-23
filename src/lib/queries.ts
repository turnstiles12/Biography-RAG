// The 20 fixed biographical queries. {person} is filled in at runtime.

export const QUERY_TEMPLATES: readonly string[] = [
  "Where and when was {person} born?",
  "Where were {person}'s parents from, and what did they do?",
  "What was {person}'s childhood like?",
  "Who were {person}'s siblings?",
  "What schooling or training did {person} have?",
  "What was {person}'s first job?",
  "An adventurous story from {person}'s life.",
  "A scary or dangerous moment {person} faced.",
  "A funny anecdote about {person}.",
  "A time {person} failed or made a serious mistake.",
  "The hardest thing {person} went through.",
  "Who did {person} marry, and what was that relationship like?",
  "What about {person}'s children?",
  "Who were {person}'s closest friends or mentors?",
  "Who were {person}'s rivals or enemies?",
  "What is {person} best known for?",
  "Something {person} made, invented or discovered.",
  "Where did {person} travel or live?",
  "A habit, hobby or quirk of {person}.",
  "How did {person} die, and how is {person} remembered?",
];

export function renderQuery(template: string, person: string): string {
  return template.replaceAll("{person}", person.trim());
}

export const NOT_IN_SOURCES = "not in the sources";
