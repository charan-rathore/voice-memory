// Lay words -> the clinical words reports use, for recall only.
//
// People ask "is my heart enlarged?" and "any fluid around the lungs?";
// reports say "cardiomegaly" and "effusion". A small embedding model does not
// reliably bridge these (measured: "fluid around the lungs" ranks "The lungs
// are hyperinflated" above "no ... effusion"), so the lexical side of the
// hybrid ranker is given the clinical words too. This is the idea behind the
// Consumer Health Vocabulary (Zeng & Tse, JAMIA 2006) used by MedlinePlus.
// It widens what is searched; it never adds words to an answer, and every
// answer is still a verbatim, cited sentence that has to pass the gate.
export const LAY_TERMS = [
  ["enlarged heart", ["cardiomegaly"]],
  ["heart enlarged", ["cardiomegaly"]],
  ["big heart", ["cardiomegaly"]],
  ["fluid", ["effusion", "edema", "oedema", "collection"]],
  ["water in", ["effusion", "edema"]],
  ["swelling", ["edema", "oedema", "swollen"]],
  ["swollen", ["edema", "enlarged", "adenopathy", "lymphadenopathy"]],
  ["lymph node", ["adenopathy", "lymphadenopathy", "node", "nodes"]],
  ["lymph nodes", ["adenopathy", "lymphadenopathy", "node", "nodes"]],
  ["glands", ["adenopathy", "lymphadenopathy"]],
  ["collapsed lung", ["pneumothorax", "atelectasis"]],
  ["air leak", ["pneumothorax"]],
  ["broken", ["fracture", "fractures"]],
  ["break", ["fracture"]],
  ["crack", ["fracture"]],
  ["kidney stone", ["nephrolithiasis", "calculus", "calculi", "renal"]],
  ["stones", ["calculus", "calculi", "lithiasis"]],
  ["stone", ["calculus", "calculi", "lithiasis"]],
  ["gallstone", ["cholelithiasis", "calculus"]],
  ["gallstones", ["cholelithiasis", "calculi"]],
  ["fatty liver", ["steatosis", "fatty", "infiltration"]],
  ["enlarged liver", ["hepatomegaly"]],
  ["liver enlarged", ["hepatomegaly"]],
  ["enlarged spleen", ["splenomegaly"]],
  ["blood clot", ["thrombus", "thrombosis", "embolism", "embolus"]],
  ["clot", ["thrombus", "thrombosis", "embolus"]],
  ["lump", ["mass", "nodule", "lesion"]],
  ["spot", ["nodule", "lesion", "opacity", "focus", "foci"]],
  ["shadow", ["opacity", "opacification", "density"]],
  ["patch", ["opacity", "opacification", "patchy"]],
  ["infection", ["infectious", "inflammatory", "consolidation"]],
  ["inflammation", ["inflammatory", "inflamed"]],
  ["hardening of the arteries", ["atherosclerosis", "calcification"]],
  ["arteries", ["arterial", "atherosclerosis", "coronary"]],
  ["narrowing", ["stenosis", "narrowed"]],
  ["bulge", ["herniation", "aneurysm", "protrusion"]],
  ["slipped disc", ["herniation", "protrusion", "disc"]],
  ["smoker", ["smoking", "tobacco", "smoke"]],
  ["smoke", ["smoking", "tobacco"]],
  ["breathing", ["respiratory", "dyspnea", "breath"]],
  ["short of breath", ["dyspnea", "breathlessness"]],
  ["heartburn", ["reflux", "hiatal"]],
  ["hernia", ["hernia", "herniation", "hiatal"]],
  ["wear and tear", ["degenerative", "spondylosis"]],
  ["arthritis", ["degenerative", "spondylosis", "arthropathy"]],
  [
    "spine",
    ["spinal", "vertebral", "spondylosis", "thoracic", "lumbar", "cervical"],
  ],
  ["back", ["spine", "spinal", "lumbar", "thoracic", "vertebral"]],
  ["dye", ["contrast"]],
  ["x-ray", ["radiograph", "xray"]],
  ["xray", ["radiograph"]],
  ["scan", ["ct", "mri", "imaging", "study", "exam"]],
  ["blood pressure", ["hypertension", "bp"]],
  ["high blood pressure", ["hypertension"]],
  ["sugar", ["glucose", "diabetes", "diabetic"]],
  ["memory", ["dementia", "cognitive", "cognition"]],
  ["stroke", ["infarct", "infarction", "cerebrovascular"]],
  ["heart attack", ["myocardial", "infarction"]],
  ["kidney", ["renal"]],
  ["kidneys", ["renal"]],
  ["liver", ["hepatic"]],
  ["lung", ["pulmonary", "lungs"]],
  ["lungs", ["pulmonary", "lung"]],
  ["brain", ["cerebral", "intracranial"]],
  ["bowel", ["colon", "colonic", "intestinal"]],
  ["pouches", ["diverticula", "diverticulosis"]],
  ["thyroid", ["thyroid", "tsh"]],
  ["cancer", ["malignancy", "malignant", "neoplasm", "carcinoma"]],
  ["tumor", ["mass", "neoplasm", "lesion"]],
  ["tumour", ["mass", "neoplasm", "lesion"]],
  ["normal", ["unremarkable", "normal", "clear"]],
  ["fine", ["unremarkable", "normal"]],
  ["medicine", ["medication", "medications", "prescribed"]],
  ["medicines", ["medication", "medications", "prescribed"]],
  ["doctor", ["physician", "consultant"]],
];

/** Extra clinical words for a question (lowercase); empty when nothing applies. */
export function layExpand(question) {
  const q = ` ${String(question)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")} `;
  const out = new Set();
  for (const [lay, clin] of LAY_TERMS)
    if (q.includes(` ${lay} `)) for (const c of clin) out.add(c);
  return [...out];
}
