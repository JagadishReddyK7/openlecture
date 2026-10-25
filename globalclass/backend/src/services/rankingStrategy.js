// Strategy Pattern — pluggable question ranking algorithms
//
// Each strategy has two forms that must agree on the order:
//   compare  sorts a list in memory (Postgres path: ended lectures, REST GET)
//   index    which Redis sorted set keeps a LIVE lecture's unanswered
//            questions in this order, and which direction to read it. A
//            broadcast then reads the top K (O(log N + K)) instead of
//            fetching and sorting every question on every update.
//
// Live index members are `${created_at}|${id}` (ISO time, so members sort by
// time). Redis orders equal scores by member, which gives an exact recency
// tie-break without packing time into a float score:
//   votes   score = vote count, read high→low: equal votes → newest first
//   votesFifo score = -vote count, read low→high: equal votes → oldest first
//   recent  score = 0, read high→low: pure member order → newest first
// See qaService.js for where the sets are maintained.

const time = (q) => new Date(q.created_at).getTime();

const newestFirst = (a, b) =>
  time(b) - time(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const oldestFirst = (a, b) => -newestFirst(a, b);

const byVotes = (a, b) => b.vote_count - a.vote_count || oldestFirst(a, b);

const byVotesThenRecency = (a, b) => b.vote_count - a.vote_count || newestFirst(a, b);

const strategies = {
  // Most voted; among equal votes the question asked first stays ahead
  votes:   { compare: byVotes,            index: { name: 'votesFifo', desc: false } },
  recency: { compare: newestFirst,        index: { name: 'recent',    desc: true } },
  // Most voted; among equal votes the newest question surfaces first
  default: { compare: byVotesThenRecency, index: { name: 'votes',     desc: true } },
};

const pick = (strategy) => strategies[strategy] || strategies.default;

export function rank(questions, strategy = 'default') {
  return [...questions].sort(pick(strategy).compare);
}

export function liveIndex(strategy = 'default') {
  return pick(strategy).index;
}

const rankingStrategy = { rank, liveIndex };
export default rankingStrategy;
