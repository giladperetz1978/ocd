(() => {
  'use strict';
  const fail = m => { throw new Error(m); };
  const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest/';
  const CTGOV = 'https://clinicaltrials.gov/api/v2/studies';
  const CTIS = 'https://euclinicaltrials.eu/ctis-public-api/search';
  const CT_FIELDS = 'NCTId,BriefTitle,BriefSummary,StdAge,MinimumAge,MaximumAge,OverallStatus,Phase,EnrollmentCount,DesignAllocation,PrimaryOutcomeMeasure,PrimaryOutcomeTimeFrame,SecondaryOutcomeMeasure,SecondaryOutcomeTimeFrame,Reference,HasResults,LastUpdatePostDate,LocationCountry';
  const MAX_TEXT = 150000;

  async function http(url, options = {}, timeout = 60000, retry = true) {
    let res;
    try {
      res = await fetch(url, {credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(timeout), ...options});
    } catch (e) {
      fail(e.name === 'TimeoutError' ? 'תם הזמן להמתנה לשרת' : 'שגיאת רשת');
    }
    if (res.status >= 500 && retry) {
      await new Promise(r => setTimeout(r, 1500));
      return http(url, options, timeout, false);
    }
    if (!res.ok) fail('HTTP ' + res.status);
    return res;
  }
  const getJson = (url, opts, timeout) => http(url, opts, timeout).then(r => r.json());

  const clean = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const now = () => new Date().toISOString();
  const CHILD = /\b(child|children|childhood|adolescen\w*|pediatric|paediatric|youth|juvenile|teen\w*|school-age\w*)\b/i;
  const ADULT = /\b(adults?|adulthood)\b/i;
  function guessAge(text) {
    const c = CHILD.test(text), a = ADULT.test(text);
    return c && a ? 'mixed' : c ? 'child' : a ? 'adult' : 'unknown';
  }
  function registryIds(text) {
    const s = String(text || '');
    const ids = [...s.matchAll(/\bNCT\d{8}\b/g), ...s.matchAll(/\bISRCTN\d{8}\b/g), ...s.matchAll(/\b(?:19|20)\d{2}-\d{6}-\d{2}(?:-\d{2})?\b/g)].map(m => m[0]);
    return [...new Set(ids)];
  }
  const termWords = term => term.toLowerCase().replace(/\b(and|or|not)\b/g, ' ').match(/[a-z0-9][a-z0-9-]{2,}/g) || [];

  function paperRecord(p, query) {
    const preprint = p.source === 'PPR';
    const text = clean(p.abstractText) || 'לא זמין תקציר.';
    return {
      id: (preprint ? 'PPR:' : 'PMID:') + p.id,
      kind: preprint ? 'preprint' : 'paper',
      db: preprint ? 'Europe PMC · preprint' : 'Europe PMC',
      title: clean(p.title) || '(ללא כותרת)',
      url: preprint ? 'https://europepmc.org/article/PPR/' + encodeURIComponent(p.id) : 'https://pubmed.ncbi.nlm.nih.gov/' + encodeURIComponent(p.id) + '/',
      year: p.pubYear || '', authors: p.authorString || '', journal: p.journalTitle || p.journalInfo?.journal?.title || '',
      pubTypes: (p.pubTypeList?.pubType || []).join(', '),
      pmcid: p.pmcid || '', openAccess: p.isOpenAccess === 'Y' && !!p.pmcid,
      ageGuess: guessAge(p.title + ' ' + text),
      text: ['Title: ' + clean(p.title), 'Journal: ' + (p.journalTitle || ''), 'Year: ' + (p.pubYear || ''), 'Publication type: ' + (p.pubTypeList?.pubType || []).join(', '), 'Abstract: ' + text].join('\n'),
      registryIds: registryIds(text), query, retrieved: now()
    };
  }

  async function europePmc(term, {preprints, peerReviewed = true, age, cursor = '*', pageSize = 20} = {}) {
    const srcs = [peerReviewed && 'SRC:MED', preprints && 'SRC:PPR'].filter(Boolean);
    if (!srcs.length) return {items: [], next: null, total: 0};
    let query = '(TITLE_ABS:"obsessive-compulsive disorder" OR TITLE_ABS:"obsessive compulsive disorder")';
    if (term) query += ' AND (' + term + ')';
    if (age === 'child') query += ' AND (TITLE_ABS:child* OR TITLE_ABS:adolescen* OR TITLE_ABS:pediatric OR TITLE_ABS:paediatric OR TITLE_ABS:youth)';
    if (age === 'adult') query += ' AND (TITLE_ABS:adult*)';
    query += ' AND (' + srcs.join(' OR ') + ')';
    const data = await getJson(EPMC + 'search?' + new URLSearchParams({query, format: 'json', resultType: 'core', pageSize: String(pageSize), sort: 'FIRST_PDATE_D desc', cursorMark: cursor}), {}, 90000);
    const items = (data.resultList?.result || []).map(p => paperRecord(p, 'Europe PMC: ' + query));
    return {items, next: items.length && data.nextCursorMark && data.nextCursorMark !== cursor ? data.nextCursorMark : null, total: data.hitCount || 0};
  }

  function trialRecord(s, query) {
    const p = s.protocolSection || {}, id = p.identificationModule?.nctId;
    const el = p.eligibilityModule || {}, st = p.statusModule || {}, d = p.designModule || {};
    const out = p.outcomesModule || {};
    const refs = p.referencesModule?.references || [];
    const std = el.stdAges || [];
    const age = std.includes('CHILD') && (std.includes('ADULT') || std.includes('OLDER_ADULT')) ? 'mixed' : std.includes('CHILD') ? 'child' : std.length ? 'adult' : 'unknown';
    const lines = [
      'Title: ' + (p.identificationModule?.briefTitle || ''),
      'Registry: ClinicalTrials.gov ' + id,
      'Status: ' + (st.overallStatus || 'not stated') + '; last update: ' + (st.lastUpdatePostDateStruct?.date || 'not stated'),
      'Phase: ' + ((d.phases || []).join(', ') || 'not stated') + '; allocation: ' + (d.designInfo?.allocation || 'not stated') + '; enrollment: ' + (d.enrollmentInfo?.count ?? 'not stated'),
      'Eligible ages: ' + (el.minimumAge || 'not stated') + ' to ' + (el.maximumAge || 'not stated') + ' (' + (std.join(', ') || 'not stated') + ')',
      'Countries: ' + [...new Set((p.contactsLocationsModule?.locations || []).map(l => l.country).filter(Boolean))].join(', '),
      'Brief summary: ' + clean(p.descriptionModule?.briefSummary),
      ...(out.primaryOutcomes || []).map(o => 'Planned primary outcome: ' + o.measure + ' | time frame: ' + (o.timeFrame || 'not stated')),
      ...(out.secondaryOutcomes || []).map(o => 'Planned secondary outcome: ' + o.measure + ' | time frame: ' + (o.timeFrame || 'not stated')),
      'Results posted to registry: ' + (s.hasResults ? 'yes' : 'no')
    ];
    return {
      id, kind: 'trial', db: 'ClinicalTrials.gov', title: p.identificationModule?.briefTitle || id,
      url: 'https://clinicaltrials.gov/study/' + encodeURIComponent(id),
      year: (st.lastUpdatePostDateStruct?.date || '').slice(0, 4), hasResults: !!s.hasResults,
      ageGuess: age, ageFromRegistry: true,
      resultPmids: refs.filter(r => r.type === 'RESULT' && /^\d+$/.test(r.pmid || '')).map(r => r.pmid),
      text: lines.join('\n'), registryIds: [id], query, retrieved: now()
    };
  }

  async function clinicalTrials(term, {age, cursor, pageSize = 20} = {}) {
    const params = {'query.cond': 'Obsessive-Compulsive Disorder', pageSize: String(pageSize), sort: 'LastUpdatePostDate:desc', fields: CT_FIELDS, countTotal: 'true'};
    if (term) params['query.term'] = term;
    if (age === 'child') params['filter.advanced'] = 'AREA[StdAge]CHILD';
    if (age === 'adult') params['filter.advanced'] = 'AREA[StdAge]ADULT';
    if (cursor) params.pageToken = cursor;
    const data = await getJson(CTGOV + '?' + new URLSearchParams(params));
    const query = 'ClinicalTrials.gov: condition=OCD; term=' + (term || '') + (age ? '; age=' + age : '');
    return {items: (data.studies || []).map(s => trialRecord(s, query)), next: data.nextPageToken || null, total: data.totalCount || 0};
  }

  function ctisRecord(t, query) {
    const age = String(t.ageGroup || '');
    const child = /0-17|under 18|in utero|preterm|newborn|infant|child|adolescent/i.test(age);
    const adult = /18-64|65\+/.test(age);
    const lines = [
      'Title: ' + (t.ctTitle || ''), 'Registry: EU CTIS ' + t.ctNumber, 'Condition: ' + (t.conditions || ''),
      'Phase: ' + (t.trialPhase || 'not stated'), 'Sponsor: ' + (t.sponsor || '') + ' (' + (t.sponsorType || '') + ')',
      'Age groups: ' + (age || 'not stated'), 'Countries: ' + (t.trialCountries || []).join(', '),
      'Enrolled (planned): ' + (t.totalNumberEnrolled || 'not stated'), 'Start (EU): ' + (t.startDateEU || 'not stated'),
      'Primary endpoint: ' + (t.primaryEndPoint || 'not stated'), 'Endpoints: ' + (t.endPoint || 'not stated'),
      'Product: ' + (t.product || ''), 'Results received: ' + (t.resultsFirstReceived || 'not stated'), 'Last updated: ' + (t.lastUpdated || '')
    ];
    return {
      id: 'CTIS:' + t.ctNumber, kind: 'trial', db: 'EU CTIS', title: t.ctTitle || t.ctNumber,
      url: 'https://euclinicaltrials.eu/search-for-clinical-trials/?lang=en&EUCT=' + encodeURIComponent(t.ctNumber),
      year: String(t.lastUpdated || '').slice(-4), ageGuess: child && adult ? 'mixed' : child ? 'child' : adult ? 'adult' : 'unknown', ageFromRegistry: true,
      text: lines.join('\n'), registryIds: [t.ctNumber], query, retrieved: now()
    };
  }

  async function ctis(term, {age, cursor = 1} = {}) {
    const data = await getJson(CTIS, {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({pagination: {page: cursor, size: 50}, sort: {property: 'decisionDate', direction: 'DESC'}, searchCriteria: {medicalCondition: 'obsessive compulsive disorder'}})});
    const words = termWords(term);
    const all = (data.data || []).map(t => ctisRecord(t, 'EU CTIS: condition=OCD; local term filter=' + words.join(' ') + (age ? '; age=' + age : '')));
    const items = all.filter(r => (!words.length || words.some(w => r.text.toLowerCase().includes(w))) && (!age || r.ageGuess === age || r.ageGuess === 'mixed'));
    return {items, next: data.pagination?.nextPage ? cursor + 1 : null, total: data.pagination?.totalRecords || 0, note: items.length + ' מתוך ' + all.length + ' ניסויי OCD בעמוד תאמו למונחים'};
  }

  async function fullText(rec) {
    if (rec.kind !== 'trial' && rec.openAccess && rec.pmcid) {
      let xml;
      try { xml = await http(EPMC + encodeURIComponent(rec.pmcid) + '/fullTextXML', {}, 120000).then(r => r.text()); }
      catch (e) { fail('Europe PMC לא סיפק טקסט מלא (' + e.message + '). אפשר לפתוח את המאמר מהקישור'); }
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (doc.querySelector('parsererror')) fail('הטקסט המלא שהתקבל אינו XML תקין');
      for (const n of doc.querySelectorAll('ref-list, table-wrap-foot, fig, xref')) n.remove();
      const parts = [];
      for (const sec of doc.querySelectorAll('body sec')) {
        if (sec.parentElement?.closest('sec')) continue;
        parts.push(clean(sec.textContent));
      }
      const text = (parts.length ? parts : [clean(doc.querySelector('body')?.textContent)]).join('\n\n');
      if (!text) fail('לא נמצא גוף מאמר בטקסט המלא');
      return {field: 'fullText', text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT};
    }
    if (rec.db === 'ClinicalTrials.gov' && rec.hasResults) {
      const data = await studyById(rec.id, 'NCTId,ResultsSection');
      const text = resultsText(data.resultsSection || {});
      return {field: 'results', text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT};
    }
    fail(rec.kind === 'trial' ? 'לרישום זה אין תוצאות שפורסמו ב־ClinicalTrials.gov' : 'אין טקסט מלא בגישה פתוחה למאמר זה');
  }

  // The single-study endpoint lacks CORS headers on hosted origins; the search endpoint allows them.
  async function studyById(nct, fields) {
    const data = await getJson(CTGOV + '?' + new URLSearchParams({'filter.ids': nct, fields}));
    return data.studies?.[0] || fail('הניסוי ' + nct + ' לא נמצא');
  }

  function resultsText(r) {
    const lines = [];
    for (const om of r.outcomeMeasuresModule?.outcomeMeasures || []) {
      const groups = Object.fromEntries((om.groups || []).map(g => [g.id, g.title]));
      lines.push(`Posted outcome (${om.type}): ${om.title} | time frame: ${om.timeFrame || ''} | ${om.paramType || ''} ${om.unitOfMeasure || ''}`.trim());
      for (const den of om.denoms || []) lines.push('  Analyzed: ' + (den.counts || []).map(c => `${groups[c.groupId] || c.groupId}: ${c.value} ${den.units || ''}`.trim()).join('; '));
      for (const cls of om.classes || []) for (const cat of cls.categories || []) {
        const label = [cls.title, cat.title].filter(Boolean).join(' / ');
        lines.push('  ' + (label ? label + ': ' : '') + (cat.measurements || []).map(m => `${groups[m.groupId] || m.groupId}: ${m.value ?? 'NA'}${m.spread ? ' (' + om.dispersionType + ' ' + m.spread + ')' : ''}${m.lowerLimit ? ' [' + m.lowerLimit + ', ' + m.upperLimit + ']' : ''}`).join('; '));
      }
      for (const a of om.analyses || []) lines.push(`  Analysis: ${(a.groupIds || []).map(g => groups[g] || g).join(' vs ')}; method: ${a.statisticalMethod || ''}; p-value: ${a.pValue || 'not reported'}; ${a.paramType || ''} ${a.paramValue || ''}${a.ciLowerLimit ? ' CI ' + a.ciLowerLimit + ' to ' + a.ciUpperLimit : ''}`);
    }
    for (const g of r.adverseEventsModule?.eventGroups || []) lines.push(`Adverse events — ${g.title}: serious ${g.seriousNumAffected ?? 'NA'}/${g.seriousNumAtRisk ?? 'NA'}; other ${g.otherNumAffected ?? 'NA'}/${g.otherNumAtRisk ?? 'NA'}; deaths ${g.deathsNumAffected ?? 'NA'}`);
    if (r.moreInfoModule?.limitationsAndCaveats?.description) lines.push('Limitations and caveats: ' + clean(r.moreInfoModule.limitationsAndCaveats.description));
    return lines.join('\n') || 'No outcome data in results section.';
  }

  async function paperById(id) {
    const [src, num] = id.split(':');
    const data = await getJson(EPMC + 'search?' + new URLSearchParams({query: (src === 'PPR' ? 'SRC:PPR AND EXT_ID:' : 'SRC:MED AND EXT_ID:') + num, format: 'json', resultType: 'core'}), {}, 90000);
    const p = data.resultList?.result?.[0];
    if (!p) fail('המאמר ' + id + ' לא נמצא');
    return paperRecord(p, 'Linked record ' + id);
  }
  async function trialById(nct) {
    return trialRecord(await studyById(nct, CT_FIELDS), 'Linked record ' + nct);
  }
  const byId = id => /^NCT\d{8}$/.test(id) ? trialById(id) : /^(PMID|PPR):[\w]+$/.test(id) ? paperById(id) : fail('אין אפשרות לטעון אוטומטית את ' + id);

  async function links(rec) {
    const found = new Map();
    const add = (id, title, url, relation) => { if (id !== rec.id && !found.has(id)) found.set(id, {id, title, url, relation}); };
    const ids = new Set([...(rec.registryIds || []), ...registryIds((rec.fullText || '') + ' ' + (rec.text || ''))]);
    if (rec.kind !== 'trial') {
      const [src, num] = rec.id.split(':');
      try {
        const ann = await getJson('https://www.ebi.ac.uk/europepmc/annotations_api/annotationsByArticleIds?' + new URLSearchParams({articleIds: (src === 'PPR' ? 'PPR:' : 'MED:') + num, type: 'Accession Numbers', format: 'JSON'}), {}, 60000);
        for (const a of ann?.[0]?.annotations || []) for (const id of registryIds(a.exact)) ids.add(id);
      } catch { /* text-mined annotations are optional */ }
    }
    for (const id of ids) {
      if (/^NCT\d{8}$/.test(id)) add(id, 'רישום ניסוי ' + id, 'https://clinicaltrials.gov/study/' + id, rec.kind === 'trial' ? 'self' : 'רישום הניסוי מוזכר במקור');
      else if (/^ISRCTN/.test(id)) add(id, 'רישום ניסוי ' + id, 'https://www.isrctn.com/' + id, 'רישום ניסוי מוזכר במקור (טעינה ידנית)');
      else if (rec.db !== 'EU CTIS') add('CTIS:' + id, 'רישום אירופי ' + id, 'https://euclinicaltrials.eu/search-for-clinical-trials/?lang=en&EUCT=' + id, 'מספר רישום אירופי מוזכר במקור (טעינה ידנית)');
    }
    for (const pmid of rec.resultPmids || []) add('PMID:' + pmid, 'מאמר תוצאות PMID ' + pmid, 'https://pubmed.ncbi.nlm.nih.gov/' + pmid + '/', 'סומן ברישום כמאמר תוצאות');
    const searchIds = [...ids].filter(id => /^(NCT\d{8}|ISRCTN\d{8}|\d{4}-\d{6}-\d{2}(-\d{2})?)$/.test(id)).slice(0, 5);
    for (const id of searchIds) {
      const data = await getJson(EPMC + 'search?' + new URLSearchParams({query: '"' + id + '"', format: 'json', resultType: 'lite', pageSize: '25'}), {}, 90000);
      for (const p of data.resultList?.result || []) {
        if (!['MED', 'PPR'].includes(p.source)) continue;
        const pid = (p.source === 'PPR' ? 'PPR:' : 'PMID:') + p.id;
        add(pid, clean(p.title), p.source === 'PPR' ? 'https://europepmc.org/article/PPR/' + p.id : 'https://pubmed.ncbi.nlm.nih.gov/' + p.id + '/', 'מזכיר את ' + id + ' — ייתכן שמדווח על אותו ניסוי, או רק מצטט אותו');
      }
    }
    return [...found.values()].filter(l => l.relation !== 'self');
  }

  window.Lab = Object.assign(window.Lab || {}, {sources: {europePmc, clinicalTrials, ctis, fullText, links, byId, registryIds}});
})();
