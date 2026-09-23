/**
 * Lightweight, dependency-free text analytics used by the discovery engine when no AI provider is
 * configured (and as a cross-check when one is): tokenisation, pain / willingness-to-pay signal
 * detection, TF-IDF keyphrases, document clustering, customer-segment and regulatory hints.
 *
 * Everything here is heuristic. Its outputs are labelled ESTIMATED, and the raw observed quotes
 * are always kept alongside so a human can verify the interpretation.
 */

export const STOPWORDS = new Set(
  (
    'a about above after again against all almost also am an and any are aren as at be because been before being below between both but by can cannot could ' +
    'did do does doing done down during each else even ever every few for from further get gets getting got had has have having he her here hers herself him ' +
    'himself his how however i if in into is isn it its itself just let lets like make makes many may me might more most much must my myself need needs no nor not ' +
    'now of off often on once one only or other our ours ourselves out over own per please really same say says see seem she should since so some still such ' +
    'than that the their theirs them themselves then there these they thing things think this those though through to too under until up upon us use used ' +
    'using very via want wants was way ways we well were what when where whether which while who whom why will with within without would yet you your yours ' +
    'yourself yourselves im ive youre dont doesnt didnt isnt cant wont thats theres whats hn ask show tell anyone anybody someone something anything everything ' +
    'lot lots bit good great new old best better year years day days time times people person work working works know going go goes went want trying try tried ' +
    'right left looking look looks thanks thank hello hi hey yes yeah okay ok sure maybe actually probably basically literally https http www com org net html ' +
    'amp quot gt lt nbsp edit update question answer post comment reply thread point points first last next two three'
  ).split(/\s+/),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 2 && t.length < 30 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

/** Very light stemmer — enough to merge plurals and common suffixes for clustering. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

export function bigrams(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) out.push(`${tokens[i]} ${tokens[i + 1]}`);
  return out;
}

interface SignalPattern {
  re: RegExp;
  weight: number;
  kind: 'pain' | 'wtp' | 'seeking' | 'competitor' | 'manual';
  label: string;
}

const SIGNAL_PATTERNS: SignalPattern[] = [
  { re: /\bi wish (there (was|were)|i could|someone (would|made))\b/i, weight: 0.5, kind: 'seeking', label: 'wish' },
  { re: /\bis there (a|an|any) (good |decent |simple |better )?(tool|app|service|software|way|library|product|saas|platform)\b/i, weight: 0.5, kind: 'seeking', label: 'is-there-a-tool' },
  { re: /\b(looking for|searching for|need|recommend(ation)?s? for) (a|an|some)? ?(good |simple |cheap |better )?(tool|app|service|software|solution|platform|vendor)\b/i, weight: 0.4, kind: 'seeking', label: 'looking-for-tool' },
  { re: /\b(how do (you|people|others)|what do you use (to|for)|how are you (handling|managing|dealing))\b/i, weight: 0.25, kind: 'seeking', label: 'how-do-you' },
  { re: /\b(frustrat\w*|annoy\w*|painful|pain point|nightmare|hate|hated|tedious|headache|drives me crazy|sucks|broken|terrible|awful|clunky)\b/i, weight: 0.35, kind: 'pain', label: 'frustration' },
  { re: /\b(waste[sd]? (so much |a lot of |hours|time)|hours (a|per|every) (day|week)|takes forever|time[- ]consuming|so slow)\b/i, weight: 0.4, kind: 'pain', label: 'time-waste' },
  { re: /\b(manual(ly)?|by hand|copy[- ]?(and[- ])?past(e|ing)|spreadsheets?|excel|re-?enter(ing)?|double entry)\b/i, weight: 0.3, kind: 'manual', label: 'manual-work' },
  { re: /\b(would (happily |gladly )?pay|willing to pay|shut up and take my money|i'?d pay|we'?d pay|worth paying|pay (\$|good money))\b/i, weight: 0.6, kind: 'wtp', label: 'would-pay' },
  { re: /\b(too expensive|overpriced|pricing is|costs? (us|me) \$?\d|per seat|\$\d+\s*(\/|per)\s*(mo|month|user|seat|year))\b/i, weight: 0.35, kind: 'wtp', label: 'price-sensitivity' },
  { re: /\b(alternative (to|for)|replace(ment)? for|switch(ed|ing)? (from|away from)|cheaper than|better than)\b/i, weight: 0.3, kind: 'competitor', label: 'alternative-seeking' },
  { re: /\b(doesn'?t (support|integrate|work with)|no (good )?(integration|api|export)|lacks?|missing feature|can'?t (export|integrate|automate))\b/i, weight: 0.35, kind: 'pain', label: 'missing-capability' },
  { re: /\b(compliance|audit|regulat\w+|deadline|penalt(y|ies)|fine[sd]?)\b/i, weight: 0.2, kind: 'pain', label: 'compliance-pressure' },
];

export interface TextSignals {
  painScore: number;
  wtpMentions: number;
  seekingMentions: number;
  competitorMentions: number;
  manualWorkMentions: number;
  matches: { label: string; kind: SignalPattern['kind']; excerpt: string }[];
}

export function detectSignals(text: string): TextSignals {
  const matches: TextSignals['matches'] = [];
  let raw = 0;
  let wtp = 0;
  let seeking = 0;
  let comp = 0;
  let manual = 0;
  for (const p of SIGNAL_PATTERNS) {
    const m = text.match(p.re);
    if (!m) continue;
    raw += p.weight;
    if (p.kind === 'wtp') wtp++;
    if (p.kind === 'seeking') seeking++;
    if (p.kind === 'competitor') comp++;
    if (p.kind === 'manual') manual++;
    const i = m.index ?? 0;
    matches.push({ label: p.label, kind: p.kind, excerpt: excerptAround(text, i, m[0].length) });
  }
  return { painScore: Math.min(1, raw / 1.5), wtpMentions: wtp, seekingMentions: seeking, competitorMentions: comp, manualWorkMentions: manual, matches };
}

export function excerptAround(text: string, index: number, len: number, radius = 110): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + len + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/** TF-IDF vectors over unigrams + bigrams. */
export function tfidfVectors(docs: { id: string; text: string }[]): { vectors: Map<string, Map<string, number>>; idf: Map<string, number> } {
  const df = new Map<string, number>();
  const tfs = new Map<string, Map<string, number>>();
  for (const d of docs) {
    const toks = tokenize(d.text);
    const terms = [...toks, ...bigrams(toks)];
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    tfs.set(d.id, tf);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log((1 + n) / (1 + c)) + 1);
  const vectors = new Map<string, Map<string, number>>();
  for (const [id, tf] of tfs) {
    const v = new Map<string, number>();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * (idf.get(t) ?? 1) * (t.includes(' ') ? 1.3 : 1);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    vectors.set(id, v);
  }
  return { vectors, idf };
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const o = large.get(t);
    if (o) dot += w * o;
  }
  return dot;
}

export interface Cluster {
  ids: string[];
  keywords: string[];
  cohesion: number;
}

/**
 * Greedy average-link agglomerative clustering on cosine similarity. O(n²) — fine for the few
 * hundred documents a discovery scan produces.
 */
export function clusterDocuments(docs: { id: string; text: string }[], opts: { threshold?: number; minSize?: number; maxClusters?: number } = {}): Cluster[] {
  const threshold = opts.threshold ?? 0.12;
  const minSize = opts.minSize ?? 2;
  const { vectors } = tfidfVectors(docs);
  let clusters: { ids: string[]; centroid: Map<string, number> }[] = docs.map((d) => ({ ids: [d.id], centroid: new Map(vectors.get(d.id)) }));

  const centroidOf = (ids: string[]) => {
    const c = new Map<string, number>();
    for (const id of ids) for (const [t, w] of vectors.get(id)!) c.set(t, (c.get(t) ?? 0) + w / ids.length);
    return c;
  };

  for (let iter = 0; iter < docs.length; iter++) {
    let bestI = -1;
    let bestJ = -1;
    let best = threshold;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = cosine(clusters[i]!.centroid, clusters[j]!.centroid) / Math.sqrt(norm(clusters[i]!.centroid) * norm(clusters[j]!.centroid) || 1);
        if (sim > best) {
          best = sim;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI < 0) break;
    const ids = [...clusters[bestI]!.ids, ...clusters[bestJ]!.ids];
    const merged = { ids, centroid: centroidOf(ids) };
    clusters = clusters.filter((_, k) => k !== bestI && k !== bestJ);
    clusters.push(merged);
  }

  return clusters
    .filter((c) => c.ids.length >= minSize)
    .map((c) => {
      const kw = [...c.centroid.entries()]
        .filter(([t]) => !/^\d/.test(t))
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t);
      const keywords = dedupeKeywords(kw).slice(0, 8);
      const sims = c.ids.map((id) => cosine(vectors.get(id)!, c.centroid) / Math.sqrt(norm(c.centroid) || 1));
      return { ids: c.ids, keywords, cohesion: sims.reduce((a, b) => a + b, 0) / sims.length };
    })
    .sort((a, b) => b.ids.length * b.cohesion - a.ids.length * a.cohesion)
    .slice(0, opts.maxClusters ?? 20);
}

function norm(v: Map<string, number>): number {
  let s = 0;
  for (const w of v.values()) s += w * w;
  return s;
}

/** Prefer bigrams; drop unigrams already covered by a chosen bigram. */
function dedupeKeywords(sorted: string[]): string[] {
  const out: string[] = [];
  for (const k of sorted) {
    if (out.some((o) => o.includes(k) || k.includes(o))) continue;
    out.push(k);
  }
  return out;
}

export function topKeywords(texts: string[], k = 8): string[] {
  const { vectors } = tfidfVectors(texts.map((t, i) => ({ id: String(i), text: t })));
  const agg = new Map<string, number>();
  for (const v of vectors.values()) for (const [t, w] of v) agg.set(t, (agg.get(t) ?? 0) + w);
  return dedupeKeywords([...agg.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t)).slice(0, k);
}

// ───────────────────────── Customer segments ─────────────────────────

export interface SegmentHint {
  segment: string;
  b2b: boolean;
  keywords: RegExp;
  /** Order-of-magnitude count of potential buyers — MODEL ASSUMPTION placeholder, must be verified. */
  buyersAssumption: { low: number; mode: number; high: number; note: string };
}

export const SEGMENTS: SegmentHint[] = [
  { segment: 'Software developers & engineering teams', b2b: true, keywords: /\b(developer|engineer|devops|programmer|codebase|repo|github|api|sdk|deploy|kubernetes|ci\/cd|pull request)\b/i, buyersAssumption: { low: 1e6, mode: 5e6, high: 3e7, note: 'Rough global count of professional developers/teams — unverified prior.' } },
  { segment: 'Small & medium businesses', b2b: true, keywords: /\b(small business|smb|sme|my (shop|store|business)|owner-operator|mom and pop)\b/i, buyersAssumption: { low: 1e6, mode: 1e7, high: 5e7, note: 'Rough count of SMBs in target geographies — unverified prior.' } },
  { segment: 'E-commerce merchants', b2b: true, keywords: /\b(shopify|ecommerce|e-commerce|online store|woocommerce|etsy|amazon seller|dropship)\b/i, buyersAssumption: { low: 5e5, mode: 3e6, high: 2e7, note: 'Rough count of online merchants — unverified prior.' } },
  { segment: 'Accountants & bookkeepers', b2b: true, keywords: /\b(accountant|bookkeep|cpa|tax return|invoice|invoicing|reconcil|quickbooks|xero|payroll)\b/i, buyersAssumption: { low: 2e5, mode: 1e6, high: 5e6, note: 'Rough count of accounting practices — unverified prior.' } },
  { segment: 'Healthcare practices', b2b: true, keywords: /\b(clinic|patient|dental|dentist|therapist|physician|medical practice|ehr|emr|healthcare)\b/i, buyersAssumption: { low: 1e5, mode: 5e5, high: 3e6, note: 'Rough count of practices — unverified prior. Heavily regulated.' } },
  { segment: 'Property managers & landlords', b2b: true, keywords: /\b(landlord|tenant|property manag|rental|lease|real estate|hoa)\b/i, buyersAssumption: { low: 2e5, mode: 1e6, high: 1e7, note: 'Rough count — unverified prior.' } },
  { segment: 'Restaurants & hospitality', b2b: true, keywords: /\b(restaurant|cafe|bar|kitchen|menu|hospitality|hotel|catering)\b/i, buyersAssumption: { low: 2e5, mode: 1e6, high: 1e7, note: 'Rough count — unverified prior.' } },
  { segment: 'Recruiters & HR teams', b2b: true, keywords: /\b(recruit|hiring|candidate|applicant|hr team|onboarding employees|ats)\b/i, buyersAssumption: { low: 1e5, mode: 1e6, high: 5e6, note: 'Rough count — unverified prior.' } },
  { segment: 'Marketing teams & agencies', b2b: true, keywords: /\b(marketing|seo|ad spend|campaign|agency|newsletter|content calendar|social media manag)\b/i, buyersAssumption: { low: 2e5, mode: 2e6, high: 1e7, note: 'Rough count — unverified prior.' } },
  { segment: 'Sales teams', b2b: true, keywords: /\b(sales team|crm|pipeline|prospect|cold email|outbound|quota|salesforce|hubspot)\b/i, buyersAssumption: { low: 2e5, mode: 2e6, high: 1e7, note: 'Rough count — unverified prior.' } },
  { segment: 'Legal professionals', b2b: true, keywords: /\b(lawyer|attorney|law firm|legal|paralegal|contract review|litigation)\b/i, buyersAssumption: { low: 1e5, mode: 5e5, high: 2e6, note: 'Rough count — unverified prior. Regulated (unauthorised practice of law).' } },
  { segment: 'Construction & trades', b2b: true, keywords: /\b(contractor|construction|plumb|electrician|hvac|job site|estimate|bid)\b/i, buyersAssumption: { low: 2e5, mode: 1e6, high: 5e6, note: 'Rough count — unverified prior.' } },
  { segment: 'Educators & schools', b2b: true, keywords: /\b(teacher|school|classroom|student|curriculum|tutor|course)\b/i, buyersAssumption: { low: 1e5, mode: 1e6, high: 1e7, note: 'Rough count — unverified prior. Student data is regulated.' } },
  { segment: 'Nonprofits', b2b: true, keywords: /\b(nonprofit|non-profit|charity|donor|fundrais|volunteer)\b/i, buyersAssumption: { low: 1e5, mode: 1e6, high: 3e6, note: 'Rough count — unverified prior.' } },
  { segment: 'Freelancers & creators', b2b: false, keywords: /\b(freelanc|creator|youtuber|podcast|consultant|solopreneur|indie hacker)\b/i, buyersAssumption: { low: 1e6, mode: 1e7, high: 5e7, note: 'Rough count — unverified prior.' } },
  { segment: 'Startup founders', b2b: true, keywords: /\b(startup|founder|saas|mvp|product market fit|investor|fundrais)\b/i, buyersAssumption: { low: 1e5, mode: 1e6, high: 5e6, note: 'Rough count — unverified prior.' } },
  { segment: 'Consumers', b2b: false, keywords: /\b(my family|my kids|personal finance|budget(ing)? app|at home|hobby|fitness|diet)\b/i, buyersAssumption: { low: 1e6, mode: 2e7, high: 2e8, note: 'Very rough consumer reach — unverified prior.' } },
];

export function inferSegments(text: string): { segment: SegmentHint; hits: number }[] {
  return SEGMENTS.map((s) => ({ segment: s, hits: (text.match(new RegExp(s.keywords.source, 'gi')) ?? []).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
}

// ───────────────────────── Regulatory screening ─────────────────────────

export interface RegulatoryFlag {
  area: string;
  risk: number; // 0..1
  keywords: RegExp;
  note: string;
}

export const REGULATORY_FLAGS: RegulatoryFlag[] = [
  { area: 'Health data / medical', risk: 0.8, keywords: /\b(patient|medical|diagnos|clinical|health record|hipaa|prescription|therapy|mental health|ehr|emr)\b/i, note: 'Health data and medical claims are regulated (e.g. HIPAA in the US, GDPR special-category data in the EU; possible medical-device rules).' },
  { area: 'Financial services', risk: 0.75, keywords: /\b(lending|loan|credit score|bank account|brokerage|investment advice|securities|money transmi|payments? processing|insurance)\b/i, note: 'Lending, payments, investment advice and insurance typically require licences and strict compliance.' },
  { area: 'Crypto assets', risk: 0.8, keywords: /\b(crypto|bitcoin|ethereum|token sale|defi|nft|wallet|stablecoin)\b/i, note: 'Crypto asset services face securities, AML/KYC and licensing rules that vary by jurisdiction.' },
  { area: 'Children / students', risk: 0.7, keywords: /\b(children|kids|under 13|coppa|minors|student data|ferpa)\b/i, note: 'Data about children/students is regulated (e.g. COPPA, FERPA, GDPR-K).' },
  { area: 'Personal data at scale', risk: 0.45, keywords: /\b(personal data|scrap(e|ing) (profiles|emails)|contact data|data broker|people search|tracking users)\b/i, note: 'Collecting/processing personal data triggers privacy law (GDPR, CCPA); data brokering has extra obligations.' },
  { area: 'Legal advice', risk: 0.6, keywords: /\b(legal advice|draft (a )?contract|lawsuit|immigration|court filing)\b/i, note: 'Providing legal advice may constitute unauthorised practice of law.' },
  { area: 'Employment screening', risk: 0.6, keywords: /\b(background check|employment screening|credit check|tenant screening)\b/i, note: 'Background/tenant screening is regulated (e.g. FCRA in the US).' },
  { area: 'Gambling', risk: 0.9, keywords: /\b(gambling|betting|casino|sportsbook|lottery)\b/i, note: 'Gambling is licensed and restricted in most jurisdictions.' },
  { area: 'Controlled goods', risk: 0.9, keywords: /\b(firearm|cannabis|tobacco|vape|alcohol delivery|prescription drug)\b/i, note: 'Controlled goods require licences and age verification.' },
  { area: 'Outbound communications', risk: 0.3, keywords: /\b(cold email|sms marketing|robocall|mass email|telemarket)\b/i, note: 'Outbound messaging is regulated (CAN-SPAM, TCPA, GDPR/PECR).' },
];

export function screenRegulatory(text: string): { risk: number; flags: { area: string; risk: number; note: string }[] } {
  const flags = REGULATORY_FLAGS.filter((f) => f.keywords.test(text)).map((f) => ({ area: f.area, risk: f.risk, note: f.note }));
  const risk = flags.length ? Math.min(1, Math.max(...flags.map((f) => f.risk)) + 0.05 * (flags.length - 1)) : 0.15;
  return { risk, flags };
}
