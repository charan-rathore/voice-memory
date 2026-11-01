// More "what this test measures" entries for real-world reports, same rules
// as GLOSSARY in explain.mjs: general information only, paraphrased from the
// cited MedlinePlus page, never a finding about the person. Aliases are how
// people and labs name the test (abbreviations, British spellings, lay words,
// Hindi), used to match questions and printed names to one entry.
export const MORE_SOURCES = {
  platelets: "https://medlineplus.gov/lab-tests/platelet-tests/",
  wbc: "https://medlineplus.gov/lab-tests/white-blood-count-wbc/",
  rbc: "https://medlineplus.gov/lab-tests/red-blood-cell-rbc-count/",
  hematocrit: "https://medlineplus.gov/lab-tests/hematocrit-test/",
  mcv: "https://medlineplus.gov/lab-tests/red-blood-cell-rbc-indices/",
  mch: "https://medlineplus.gov/lab-tests/red-blood-cell-rbc-indices/",
  mchc: "https://medlineplus.gov/lab-tests/red-blood-cell-rbc-indices/",
  rdw: "https://medlineplus.gov/lab-tests/red-blood-cell-rbc-indices/",
  neutrophils: "https://medlineplus.gov/lab-tests/blood-differential/",
  lymphocytes: "https://medlineplus.gov/lab-tests/blood-differential/",
  monocytes: "https://medlineplus.gov/lab-tests/blood-differential/",
  eosinophils: "https://medlineplus.gov/lab-tests/blood-differential/",
  basophils: "https://medlineplus.gov/lab-tests/blood-differential/",
  esr: "https://medlineplus.gov/lab-tests/erythrocyte-sedimentation-rate-esr/",
  crp: "https://medlineplus.gov/lab-tests/c-reactive-protein-crp-test/",
  bilirubin: "https://medlineplus.gov/lab-tests/bilirubin-blood-test/",
  ast: "https://medlineplus.gov/lab-tests/ast-test/",
  alt: "https://medlineplus.gov/lab-tests/alt-blood-test/",
  alp: "https://medlineplus.gov/lab-tests/alkaline-phosphatase/",
  ggt: "https://medlineplus.gov/lab-tests/gamma-glutamyl-transferase-ggt-test/",
  albumin: "https://medlineplus.gov/lab-tests/albumin-blood-test/",
  totalprotein:
    "https://medlineplus.gov/lab-tests/total-protein-and-albumin-globulin-a-g-ratio/",
  glucose: "https://medlineplus.gov/lab-tests/blood-glucose-test/",
  cholesterol: "https://medlineplus.gov/lab-tests/cholesterol-levels/",
  hdl: "https://medlineplus.gov/lab-tests/cholesterol-levels/",
  ldl: "https://medlineplus.gov/lab-tests/cholesterol-levels/",
  triglycerides: "https://medlineplus.gov/lab-tests/triglycerides-test/",
  uricacid: "https://medlineplus.gov/lab-tests/uric-acid-test/",
  sodium: "https://medlineplus.gov/lab-tests/sodium-blood-test/",
  chloride: "https://medlineplus.gov/lab-tests/chloride-blood-test/",
  calcium: "https://medlineplus.gov/lab-tests/calcium-blood-test/",
  vitamind: "https://medlineplus.gov/lab-tests/vitamin-d-test/",
  vitaminb12: "https://medlineplus.gov/lab-tests/vitamin-b-levels/",
  t3: "https://medlineplus.gov/lab-tests/thyroid-function-tests/",
  t4: "https://medlineplus.gov/lab-tests/thyroid-function-tests/",
  dengue: "https://medlineplus.gov/lab-tests/dengue-fever-test/",
};

export const MORE_GLOSSARY = {
  platelets: {
    en: "Platelets are small blood cells that help blood clot.",
    hi: "प्लेटलेट्स खून की छोटी कोशिकाएं हैं जो खून का थक्का बनाने में मदद करती हैं।",
    hinglish:
      "Platelets khoon ki chhoti cells hain jo khoon ka thakka banane mein madad karti hain.",
    aliases: [
      "platelet",
      "platelet count",
      "plt",
      "thrombocytes",
      "thrombocyte count",
      "प्लेटलेट",
      "प्लेटलेट्स",
      "platelets count",
      "clotting cells",
    ],
  },
  wbc: {
    en: "White blood cells are the cells that help the body fight infection.",
    hi: "सफ़ेद रक्त कोशिकाएं वे कोशिकाएं हैं जो शरीर को संक्रमण से लड़ने में मदद करती हैं।",
    hinglish:
      "White blood cells woh cells hain jo body ko infection se ladne mein madad karti hain.",
    aliases: [
      "white blood cell",
      "white blood cells",
      "white cell count",
      "white cells",
      "total leukocyte count",
      "total leucocyte count",
      "tlc",
      "leukocytes",
      "leucocytes",
      "wbc",
      "wbc count",
      "total wbc count",
      "डब्ल्यूबीसी",
      "सफ़ेद रक्त कोशिकाएं",
    ],
  },
  rbc: {
    en: "The red blood cell count is how many red blood cells, the cells that carry oxygen, are in a sample of blood.",
    hi: "आरबीसी गिनती बताती है कि खून में ऑक्सीजन ले जाने वाली लाल रक्त कोशिकाएं कितनी हैं।",
    hinglish:
      "RBC count batata hai ki khoon mein oxygen le jaane wali red blood cells kitni hain.",
    aliases: [
      "red blood cell count",
      "red blood cells",
      "red cell count",
      "rbc count",
      "total rbc count",
      "rbc",
      "erythrocyte count",
      "लाल रक्त कोशिकाएं",
    ],
  },
  hematocrit: {
    en: "Hematocrit, also called packed cell volume, is the share of the blood made up of red blood cells.",
    hi: "हीमैटोक्रिट (पीसीवी) बताता है कि खून का कितना हिस्सा लाल रक्त कोशिकाओं से बना है।",
    hinglish:
      "Hematocrit (PCV) batata hai ki khoon ka kitna hissa red blood cells se bana hai.",
    aliases: ["hematocrit", "haematocrit", "hct", "pcv", "packed cell volume"],
  },
  mcv: {
    en: "MCV is the average size of your red blood cells.",
    hi: "एमसीवी लाल रक्त कोशिकाओं का औसत आकार है।",
    hinglish: "MCV red blood cells ka average size hai.",
    aliases: ["mean corpuscular volume", "mean cell volume", "mcv"],
  },
  mch: {
    en: "MCH is the average amount of hemoglobin in each red blood cell.",
    hi: "एमसीएच हर लाल रक्त कोशिका में हीमोग्लोबिन की औसत मात्रा है।",
    hinglish: "MCH har red blood cell mein hemoglobin ki average matra hai.",
    aliases: ["mean corpuscular hemoglobin", "mean cell hemoglobin", "mch"],
  },
  mchc: {
    en: "MCHC is how concentrated the hemoglobin is inside red blood cells, on average.",
    hi: "एमसीएचसी बताता है कि लाल रक्त कोशिकाओं के अंदर हीमोग्लोबिन औसतन कितना गाढ़ा है।",
    hinglish:
      "MCHC batata hai ki red blood cells ke andar hemoglobin average mein kitna concentrated hai.",
    aliases: [
      "mean corpuscular hemoglobin concentration",
      "mean corpuscular hb concentration",
      "mean cell hemoglobin concentration",
      "mchc",
    ],
  },
  rdw: {
    en: "RDW shows how much your red blood cells vary in size.",
    hi: "आरडीडब्ल्यू बताता है कि लाल रक्त कोशिकाओं के आकार में कितना फ़र्क है।",
    hinglish: "RDW batata hai ki red blood cells ke size mein kitna farak hai.",
    aliases: ["red cell distribution width", "rdw", "rdw cv", "rdw-cv"],
  },
  neutrophils: {
    en: "Neutrophils are the most common type of white blood cell; they are often the first to respond to infection.",
    hi: "न्यूट्रोफिल सबसे आम सफ़ेद रक्त कोशिकाएं हैं; संक्रमण होने पर अक्सर ये सबसे पहले प्रतिक्रिया करती हैं।",
    hinglish:
      "Neutrophils sabse aam white blood cells hain; infection hone par aksar yeh sabse pehle react karti hain.",
    aliases: [
      "neutrophil",
      "neutrophils",
      "polymorphs",
      "segmented neutrophils",
      "न्यूट्रोफिल",
    ],
  },
  lymphocytes: {
    en: "Lymphocytes are white blood cells that are part of the immune system.",
    hi: "लिम्फोसाइट्स सफ़ेद रक्त कोशिकाएं हैं जो रोग प्रतिरोधक तंत्र का हिस्सा हैं।",
    hinglish:
      "Lymphocytes white blood cells hain jo immune system ka hissa hain.",
    aliases: ["lymphocyte", "lymphocytes", "लिम्फोसाइट"],
  },
  monocytes: {
    en: "Monocytes are white blood cells that help clear germs and damaged cells.",
    hi: "मोनोसाइट्स सफ़ेद रक्त कोशिकाएं हैं जो कीटाणुओं और खराब कोशिकाओं को हटाने में मदद करती हैं।",
    hinglish:
      "Monocytes white blood cells hain jo germs aur kharab cells ko hatane mein madad karti hain.",
    aliases: ["monocyte", "monocytes"],
  },
  eosinophils: {
    en: "Eosinophils are white blood cells involved in allergic reactions and some infections.",
    hi: "इओसिनोफिल सफ़ेद रक्त कोशिकाएं हैं जो एलर्जी और कुछ संक्रमणों में शामिल होती हैं।",
    hinglish:
      "Eosinophils white blood cells hain jo allergy aur kuch infections mein shaamil hoti hain.",
    aliases: ["eosinophil", "eosinophils", "absolute eosinophil count", "aec"],
  },
  basophils: {
    en: "Basophils are the least common white blood cells; they take part in allergic responses.",
    hi: "बेसोफिल सबसे कम पाई जाने वाली सफ़ेद रक्त कोशिकाएं हैं; ये एलर्जी की प्रतिक्रिया में भाग लेती हैं।",
    hinglish:
      "Basophils sabse kam paayi jaane wali white blood cells hain; yeh allergy ke response mein hissa leti hain.",
    aliases: ["basophil", "basophils"],
  },
  esr: {
    en: "ESR measures how quickly red blood cells settle in a tube; it can rise with inflammation.",
    hi: "ईएसआर मापता है कि लाल रक्त कोशिकाएं नली में कितनी जल्दी नीचे बैठती हैं; सूजन होने पर यह बढ़ सकता है।",
    hinglish:
      "ESR measure karta hai ki red blood cells tube mein kitni jaldi neeche baithti hain; inflammation mein yeh badh sakta hai.",
    aliases: ["esr", "erythrocyte sedimentation rate", "sed rate"],
  },
  crp: {
    en: "C-reactive protein is made by the liver and rises when there is inflammation in the body.",
    hi: "सी-रिएक्टिव प्रोटीन लिवर बनाता है, और शरीर में सूजन होने पर यह बढ़ता है।",
    hinglish:
      "C-reactive protein liver banata hai, aur body mein inflammation hone par yeh badhta hai.",
    aliases: [
      "c reactive protein",
      "c-reactive protein",
      "crp",
      "hs crp",
      "hscrp",
    ],
  },
  bilirubin: {
    en: "Bilirubin is a yellow substance made when red blood cells break down; the liver clears it from the body.",
    hi: "बिलीरुबिन एक पीला पदार्थ है जो लाल रक्त कोशिकाओं के टूटने से बनता है; लिवर इसे शरीर से बाहर निकालता है।",
    hinglish:
      "Bilirubin ek peela padarth hai jo red blood cells ke tootne se banta hai; liver ise body se bahar nikalta hai.",
    aliases: [
      "bilirubin",
      "total bilirubin",
      "direct bilirubin",
      "indirect bilirubin",
      "conjugated bilirubin",
      "unconjugated bilirubin",
      "बिलीरुबिन",
    ],
  },
  ast: {
    en: "AST, also called SGOT, is an enzyme found mostly in the liver and muscles.",
    hi: "एएसटी (एसजीओटी) एक एंजाइम है जो ज़्यादातर लिवर और मांसपेशियों में होता है।",
    hinglish:
      "AST (SGOT) ek enzyme hai jo zyadatar liver aur muscles mein hota hai.",
    aliases: [
      "ast",
      "sgot",
      "aspartate aminotransferase",
      "aspartate transaminase",
    ],
  },
  alt: {
    en: "ALT, also called SGPT, is an enzyme found mostly in the liver; it is used to check the liver.",
    hi: "एएलटी (एसजीपीटी) एक एंजाइम है जो ज़्यादातर लिवर में होता है; इससे लिवर की जांच होती है।",
    hinglish:
      "ALT (SGPT) ek enzyme hai jo zyadatar liver mein hota hai; isse liver ki jaanch hoti hai.",
    aliases: [
      "alt",
      "sgpt",
      "alanine aminotransferase",
      "alanine transaminase",
    ],
  },
  alp: {
    en: "Alkaline phosphatase is an enzyme found mainly in the liver and bones.",
    hi: "एल्कलाइन फॉस्फेटेज़ एक एंजाइम है जो मुख्य रूप से लिवर और हड्डियों में होता है।",
    hinglish:
      "Alkaline phosphatase ek enzyme hai jo mainly liver aur haddiyon mein hota hai.",
    aliases: ["alkaline phosphatase", "alp", "alk phos"],
  },
  ggt: {
    en: "GGT is an enzyme found mostly in the liver; it is one of the liver checks.",
    hi: "जीजीटी एक एंजाइम है जो ज़्यादातर लिवर में होता है; यह लिवर की जांचों में से एक है।",
    hinglish:
      "GGT ek enzyme hai jo zyadatar liver mein hota hai; yeh liver ki jaanchon mein se ek hai.",
    aliases: [
      "ggt",
      "ggtp",
      "gamma gt",
      "gamma g.t",
      "gamma glutamyl transferase",
      "gamma glutamyl transpeptidase",
    ],
  },
  albumin: {
    en: "Albumin is the main protein made by the liver; it keeps fluid in the bloodstream.",
    hi: "एल्ब्यूमिन लिवर में बनने वाला मुख्य प्रोटीन है; यह खून की नलियों में तरल बनाए रखता है।",
    hinglish:
      "Albumin liver mein banne wala main protein hai; yeh khoon ki naliyon mein fluid banaye rakhta hai.",
    aliases: ["albumin", "serum albumin"],
  },
  totalprotein: {
    en: "Total protein is the amount of albumin and globulin proteins in the blood.",
    hi: "टोटल प्रोटीन खून में एल्ब्यूमिन और ग्लोब्युलिन प्रोटीन की कुल मात्रा है।",
    hinglish:
      "Total protein khoon mein albumin aur globulin protein ki kul matra hai.",
    aliases: [
      "total protein",
      "total proteins",
      "globulin",
      "a/g ratio",
      "albumin globulin ratio",
      "a g ratio",
    ],
  },
  glucose: {
    en: "Blood glucose is the amount of sugar in the blood at the time of the test.",
    hi: "ब्लड ग्लूकोज़ जांच के समय खून में शुगर की मात्रा है।",
    hinglish: "Blood glucose jaanch ke samay khoon mein sugar ki matra hai.",
    aliases: [
      "glucose",
      "blood sugar",
      "fasting blood sugar",
      "fasting glucose",
      "fbs",
      "ppbs",
      "postprandial blood sugar",
      "random blood sugar",
      "rbs",
      "sugar",
      "शुगर",
      "ग्लूकोज़",
    ],
  },
  cholesterol: {
    en: "Cholesterol is a waxy fat in the blood; a lipid profile measures its different types.",
    hi: "कोलेस्ट्रॉल खून में मौजूद एक चिकना पदार्थ है; लिपिड प्रोफ़ाइल इसके अलग-अलग प्रकार मापती है।",
    hinglish:
      "Cholesterol khoon mein ek chikna padarth hai; lipid profile iske alag-alag types measure karti hai.",
    aliases: [
      "cholesterol",
      "total cholesterol",
      "serum cholesterol",
      "कोलेस्ट्रॉल",
    ],
  },
  hdl: {
    en: "HDL is the cholesterol carried in high-density lipoproteins, often called good cholesterol.",
    hi: "एचडीएल को अक्सर अच्छा कोलेस्ट्रॉल कहा जाता है।",
    hinglish: "HDL ko aksar good cholesterol kaha jata hai.",
    aliases: ["hdl", "hdl cholesterol", "good cholesterol"],
  },
  ldl: {
    en: "LDL is the cholesterol carried in low-density lipoproteins, often called bad cholesterol.",
    hi: "एलडीएल को अक्सर खराब कोलेस्ट्रॉल कहा जाता है।",
    hinglish: "LDL ko aksar bad cholesterol kaha jata hai.",
    aliases: ["ldl", "ldl cholesterol", "direct ldl", "bad cholesterol"],
  },
  triglycerides: {
    en: "Triglycerides are a type of fat in the blood that the body uses for energy.",
    hi: "ट्राइग्लिसराइड्स खून में एक तरह की चर्बी है जिसे शरीर ऊर्जा के लिए इस्तेमाल करता है।",
    hinglish:
      "Triglycerides khoon mein ek tarah ki fat hai jise body energy ke liye use karti hai.",
    aliases: ["triglyceride", "triglycerides", "tg"],
  },
  uricacid: {
    en: "Uric acid is a waste product the body makes when it breaks down purines; the kidneys remove it.",
    hi: "यूरिक एसिड एक अपशिष्ट है जो प्यूरीन के टूटने से बनता है; किडनी इसे बाहर निकालती है।",
    hinglish:
      "Uric acid ek waste hai jo purines tootne se banta hai; kidney ise bahar nikalti hai.",
    aliases: ["uric acid", "serum uric acid", "यूरिक एसिड"],
  },
  sodium: {
    en: "Sodium is a mineral that helps control the balance of water in the body.",
    hi: "सोडियम एक खनिज है जो शरीर में पानी का संतुलन बनाए रखने में मदद करता है।",
    hinglish:
      "Sodium ek mineral hai jo body mein paani ka balance banaye rakhne mein madad karta hai.",
    aliases: ["sodium", "na", "serum sodium"],
  },
  chloride: {
    en: "Chloride is a mineral that works with sodium to keep the body's fluids in balance.",
    hi: "क्लोराइड एक खनिज है जो सोडियम के साथ शरीर के तरल का संतुलन बनाए रखता है।",
    hinglish:
      "Chloride ek mineral hai jo sodium ke saath body ke fluids ka balance banaye rakhta hai.",
    aliases: ["chloride", "cl", "serum chloride"],
  },
  calcium: {
    en: "Calcium is a mineral the body needs for bones, muscles, nerves and the heart.",
    hi: "कैल्शियम एक खनिज है जिसकी ज़रूरत हड्डियों, मांसपेशियों, नसों और दिल को होती है।",
    hinglish:
      "Calcium ek mineral hai jiski zaroorat haddiyon, muscles, nerves aur dil ko hoti hai.",
    aliases: ["calcium", "total calcium", "serum calcium", "कैल्शियम"],
  },
  vitamind: {
    en: "This test measures vitamin D, which helps the body absorb calcium for strong bones.",
    hi: "यह जांच विटामिन डी मापती है, जो मज़बूत हड्डियों के लिए कैल्शियम सोखने में मदद करता है।",
    hinglish:
      "Yeh jaanch vitamin D measure karti hai, jo mazboot haddiyon ke liye calcium absorb karne mein madad karta hai.",
    aliases: [
      "vitamin d",
      "25 oh vitamin d",
      "25(oh) vitamin d",
      "25-hydroxy vitamin d",
      "vit d",
      "विटामिन डी",
    ],
  },
  vitaminb12: {
    en: "Vitamin B12 helps the body make red blood cells and keeps nerves healthy.",
    hi: "विटामिन बी12 शरीर को लाल रक्त कोशिकाएं बनाने में और नसों को ठीक रखने में मदद करता है।",
    hinglish:
      "Vitamin B12 body ko red blood cells banane aur nerves ko theek rakhne mein madad karta hai.",
    aliases: [
      "vitamin b12",
      "b12",
      "cyanocobalamin",
      "cobalamin",
      "vit b12",
      "विटामिन बी12",
    ],
  },
  t3: {
    en: "T3 is one of the two main hormones made by the thyroid gland.",
    hi: "टी3 थायरॉइड ग्रंथि के दो मुख्य हार्मोनों में से एक है।",
    hinglish: "T3 thyroid gland ke do main hormones mein se ek hai.",
    aliases: [
      "t3",
      "total t3",
      "free t3",
      "ft3",
      "triiodothyronine",
      "t3 total",
    ],
  },
  t4: {
    en: "T4, or thyroxine, is the main hormone made by the thyroid gland.",
    hi: "टी4 (थायरोक्सिन) थायरॉइड ग्रंथि का मुख्य हार्मोन है।",
    hinglish: "T4 (thyroxine) thyroid gland ka main hormone hai.",
    aliases: ["t4", "total t4", "free t4", "ft4", "thyroxine", "t4 total"],
  },
  dengue: {
    en: "Dengue tests look for the dengue virus (the NS1 antigen) or for the body's antibodies against it (IgM and IgG).",
    hi: "डेंगू जांच डेंगू वायरस (NS1 एंटीजन) या उसके खिलाफ़ शरीर की एंटीबॉडी (IgM और IgG) को खोजती है।",
    hinglish:
      "Dengue tests dengue virus (NS1 antigen) ya uske khilaf body ki antibodies (IgM aur IgG) ko dhoondhte hain.",
    aliases: [
      "dengue",
      "dengue ns1",
      "ns1",
      "ns1 antigen",
      "dengue ns1 antigen",
      "dengue igm",
      "dengue igg",
      "dengue antibody",
      "डेंगू",
    ],
  },
};

// Body systems people ask about ("how is my liver?"), as glossary keys.
export const GROUPS = {
  liver: {
    words: [
      "liver",
      "lft",
      "liver function",
      "hepatic",
      "jigar",
      "लिवर",
      "यकृत",
      "जिगर",
    ],
    keys: ["bilirubin", "ast", "alt", "alp", "ggt", "albumin", "totalprotein"],
  },
  kidney: {
    words: [
      "kidney",
      "kidneys",
      "renal",
      "kft",
      "rft",
      "kidney function",
      "गुर्दे",
      "किडनी",
    ],
    keys: [
      "creatinine",
      "urea",
      "uricacid",
      "sodium",
      "potassium",
      "chloride",
      "calcium",
    ],
  },
  thyroid: {
    words: ["thyroid", "थायरॉइड"],
    keys: ["tsh", "t3", "t4"],
  },
  sugar: {
    words: ["sugar", "diabetes", "glucose", "शुगर", "मधुमेह"],
    keys: ["glucose", "hba1c"],
  },
  lipids: {
    words: [
      "cholesterol",
      "lipid",
      "lipids",
      "lipid profile",
      "fats",
      "heart",
      "कोलेस्ट्रॉल",
    ],
    keys: ["cholesterol", "hdl", "ldl", "triglycerides"],
  },
  blood: {
    words: [
      "blood count",
      "cbc",
      "complete blood count",
      "hemogram",
      "haemogram",
      "blood picture",
      "blood cells",
      "खून",
      "ब्लड",
    ],
    keys: [
      "hemoglobin",
      "rbc",
      "wbc",
      "platelets",
      "hematocrit",
      "mcv",
      "mch",
      "mchc",
      "rdw",
      "neutrophils",
      "lymphocytes",
      "monocytes",
      "eosinophils",
      "basophils",
    ],
  },
  infection: {
    words: [
      "infection",
      "fever",
      "inflammation",
      "dengue",
      "संक्रमण",
      "बुखार",
      "डेंगू",
      "bukhar",
    ],
    keys: [
      "dengue",
      "crp",
      "esr",
      "wbc",
      "neutrophils",
      "lymphocytes",
      "platelets",
    ],
  },
  iron: {
    words: ["iron", "anemia", "anaemia", "आयरन", "खून की कमी"],
    keys: ["hemoglobin", "ferritin", "mcv", "mch", "rbc"],
  },
  vitamins: {
    words: ["vitamin", "vitamins", "विटामिन"],
    keys: ["vitamind", "vitaminb12"],
  },
};
