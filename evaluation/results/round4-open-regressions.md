# Round 4 open regressions

Not release-qualified. Individual failures below need classification and repair; do not blanket-treat them as expected snapshots.



## r4-fullclin

### anonymous reports are never attributed to the caller (graph audit \#1)

```

---
  duration_ms: 0.920848
  type: 'test'
  location: '/tmp/vm/clinical/clinical.test.mjs:532:1'
  failureType: 'testCodeFailure'
  error: |-
    These reports have Creatinine results for more than one person (a-2026-09.pdf, c-2026-10.pdf). Whose results should I look at?
    + actual - expected
    
    + 'AMBIGUOUS_PATIENT'
    - 'NOT_COMPARABLE'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'NOT_COMPARABLE'
  actual: 'AMBIGUOUS_PATIENT'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/clinical/clinical.test.mjs:542:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

## r4-fulleval

### mixed, help, overview, thanks and goodbye turns from a real call

```

---
  duration_ms: 801.572973
  type: 'test'
  location: '/tmp/vm/evaluation/call-replay.test.mjs:9:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /Ferritin[^।]*50 ng\/mL/. Input:
    
    'इन रिपोर्ट्स में एक से ज़्यादा लोगों के Ferritin नतीजे हैं (SYN-0001, SYN-0003)। मैं किसके नतीजे देखूं? $42,000 सबसे नया प्रस्ताव है, और यह अभी मंज़ूर नहीं हुआ है। अभी खुले मुद्दे, the internal action log from October 9 के अनुसार: final payment schedule; and pilot deadline.'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: 'इन रिपोर्ट्स में एक से ज़्यादा लोगों के Ferritin नतीजे हैं (SYN-0001, SYN-0003)। मैं किसके नतीजे देखूं? $42,000 सबसे नया प्रस्ताव है, और यह अभी मंज़ूर नहीं हुआ है। अभी खुले मुद्दे, the internal action log from October 9 के अनुसार: final payment schedule; and pilot deadline.'
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/call-replay.test.mjs:21:12)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...

```

### lab conversation: context, clarifications, units, no silent patient pick

```

---
  duration_ms: 884.551996
  type: 'test'
  location: '/tmp/vm/evaluation/conversation-parity.test.mjs:80:1'
  failureType: 'testCodeFailure'
  error: 'voice: context four turns back'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: 'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
  operator: 'match'
  stack: |-
    both (file:///tmp/vm/evaluation/conversation-parity.test.mjs:73:10)
    TestContext.<anonymous> (file:///tmp/vm/evaluation/conversation-parity.test.mjs:115:3)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...

```

### real call, 31 Oct: hear-check, compound question, Hindi, screen

```

---
  duration_ms: 128.455941
  type: 'test'
  location: '/tmp/vm/evaluation/conversation.test.mjs:166:1'
  failureType: 'testCodeFailure'
  error: 'इन रिपोर्ट्स में एक से ज़्यादा लोगों के Creatinine नतीजे हैं (SYN-0001, SYN-0003)। मैं किसके नतीजे देखूं?'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: 'इन रिपोर्ट्स में एक से ज़्यादा लोगों के Creatinine नतीजे हैं (SYN-0001, SYN-0003)। मैं किसके नतीजे देखूं?'
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/conversation.test.mjs:176:10)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

### every saved landing answer equals the engine's current answer

```

---
  duration_ms: 410.205354
  type: 'test'
  location: '/tmp/vm/evaluation/site-snapshot.test.mjs:27:1'
  failureType: 'testCodeFailure'
  error: |-
    health|Did ferritin change since the last report?
    + actual - expected
    
    + "Your Ferritin went from 0.5 ng/mL on 3 September 2026 to 50 ng/mL on 12 October 2026. That's higher than before. It's now inside the lab's range. The 12 October 2026 result was corrected from 5 to 50, and I'm using the corrected value. Some general background: Ferritin shows how much iron your body has stored. Your doctor can read it alongside how you feel, your medicines and your other results."
    - 'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
  actual: "Your Ferritin went from 0.5 ng/mL on 3 September 2026 to 50 ng/mL on 12 October 2026. That's higher than before. It's now inside the lab's range. The 12 October 2026 result was corrected from 5 to 50, and I'm using the corrected value. Some general background: Ferritin shows how much iron your body has stored. Your doctor can read it alongside how you feel, your medicines and your other results."
  operator: 'strictEqual'
  stack: |-

```

### each hero story quotes the engine's own answer, in the language asked

```

---
  duration_ms: 176.048854
  type: 'test'
  location: '/tmp/vm/evaluation/site-snapshot.test.mjs:88:1'
  failureType: 'testCodeFailure'
  error: 'units: hero says "Main aapke dono Creatinine results ki tulna nahi kar sakti: 3 September 2026 wala mg/dL mein hai aur 12 October 2026 wala µmol/L mein, aur main units convert nahi karti.", engine says "In reports mein ek se zyada logon ke Creatinine results hain (SYN-0001, SYN-0003). Main kiske results dekhoon?"'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/site-snapshot.test.mjs:122:14)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

### vernacular development set: every case, no critical failure

```

---
  duration_ms: 845.756942
  type: 'test'
  location: '/tmp/vm/evaluation/vernacular.test.mjs:28:1'
  failureType: 'testCodeFailure'
  error: |-
    [
     {
      "id": "v04",
      "q": "um mera fertin kitna aaya",
      "kind": "answer",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "In reports mein ek se zyada logon ke Ferritin results hain (SYN-0001, SYN-0003). Main kiske results dekhoon?",
      "bad": [],
      "notes": []
     },
     {
      "id": "v05",
      "q": "ferrite in result batao",
      "kind": "answer",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "In reports mein ek se zyada logon ke Ferritin results hain (SYN-0001, SYN-0003). Main kiske results dekhoon?",
      "bad": [],
      "notes": []
     },
     {
      "id": "v06",
      "q": "ferritin pehle paanch tha ab kitna hai",
      "kind": "answer",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "In reports mein ek se zyada logon ke Ferritin results hain (SYN-0001, SYN-0003). Main kiske results dekhoon?",
      "bad": [],
      "notes": []
     },
     {
      "id": "v09",
      "q": "Has creatinine gone up since September?",
      "kind": "refuse_compare",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "These reports have Creatinine results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?",
      "bad": [],
      "notes": []
     },
     {
      "

```

### vernacular held-out set: no critical failure, not below its first run

```

---
  duration_ms: 703.41795
  type: 'test'
  location: '/tmp/vm/evaluation/vernacular.test.mjs:40:1'
  failureType: 'testCodeFailure'
  error: |-
    held-out answerable 15/22: [
     {
      "id": "w02",
      "q": "फेरिटिन का नया नतीजा बताइए",
      "kind": "answer",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "इन रिपोर्ट्स में एक से ज़्यादा लोगों के Ferritin नतीजे हैं (SYN-0001, SYN-0003)। मैं किसके नतीजे देखूं?",
      "bad": [],
      "notes": []
     },
     {
      "id": "w03",
      "q": "ferritn ka value batana",
      "kind": "answer",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "In reports mein ek se zyada logon ke Ferritin results hain (SYN-0001, SYN-0003). Main kiske results dekhoon?",
      "bad": [],
      "notes": []
     },
     {
      "id": "w04",
      "q": "creatinine pehle se badh gaya hai kya",
      "kind": "refuse_compare",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "In reports mein ek se zyada logon ke Creatinine results hain (SYN-0001, SYN-0003). Main kiske results dekhoon?",
      "bad": [],
      "notes": []
     },
     {
      "id": "w05",
      "q": "क्या क्रिएटिनिन पहले से ज़्यादा है?",
      "kind": "refuse_compare",
      "verdict": "AMBIGUOUS_PATIENT",
      "said": "इन रिपोर्ट्स में एक से ज़्यादा लोगों के Creatinine नतीजे हैं (SYN-0001, SYN-0003)। मैं किसके नतीजे देखूं?",
      "bad": [],
      "notes": []
     }

```

### before the correction: the preliminary value, never the previous report's

```

---
  duration_ms: 160.752681
  type: 'test'
  location: '/tmp/vm/evaluation/voice-screen-sync.test.mjs:46:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'AMBIGUOUS_PATIENT'
    - 'VALUE'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'VALUE'
  actual: 'AMBIGUOUS_PATIENT'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/voice-screen-sync.test.mjs:49:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...

```

### a date the reports do not have stays absent, even in a correction question

```

---
  duration_ms: 0.801903
  type: 'test'
  location: '/tmp/vm/evaluation/voice-screen-sync.test.mjs:107:1'
  failureType: 'testCodeFailure'
  error: |-
    What was ferritin before the correction on 5 August?
    + actual - expected
    
    + 'AMBIGUOUS_PATIENT'
    - 'NOT_IN_REPORT'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'NOT_IN_REPORT'
  actual: 'AMBIGUOUS_PATIENT'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/voice-screen-sync.test.mjs:114:12)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

### before-the-correction, earliest, and current are three different rows

```

---
  duration_ms: 0.729958
  type: 'test'
  location: '/tmp/vm/evaluation/voice-screen-sync.test.mjs:130:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /^Before the correction[^.]*\b5 ng\/mL/. Input:
    
    'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: 'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/voice-screen-sync.test.mjs:133:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

### voice follow-up 'what was it before the correction' answers it, not the previous question

```

---
  duration_ms: 696.645283
  type: 'test'
  location: '/tmp/vm/evaluation/voice-screen-sync.test.mjs:261:1'
  failureType: 'testCodeFailure'
  error: |-
    The input did not match the regular expression /^Before the correction/. Input:
    
    'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual: 'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
  operator: 'match'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/voice-screen-sync.test.mjs:269:12)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

### typed lab follow-up carries the field and says the same sentence voice says

```

---
  duration_ms: 496.25721
  type: 'test'
  location: '/tmp/vm/evaluation/voice-screen-sync.test.mjs:277:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
    - 'Before the correction, the 12 October 2026 Ferritin result was 5 ng/mL, on the preliminary report of 13 October 2026. The amended report of 15 October 2026 corrected it to 50 ng/mL, and that is the value to use.'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'Before the correction, the 12 October 2026 Ferritin result was 5 ng/mL, on the preliminary report of 13 October 2026. The amended report of 15 October 2026 corrected it to 50 ng/mL, and that is the value to use.'
  actual: 'These reports have Ferritin results for more than one person (SYN-0001, SYN-0003). Whose results should I look at?'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/evaluation/voice-screen-sync.test.mjs:292:12)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

## r4-misc

### speech-misrecognised analyte: 'ferrite in' routes to ferritin, not a generic overview

```

---
  duration_ms: 38.872671
  type: 'test'
  location: '/tmp/vm/tests/public-api.test.mjs:41:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'AMBIGUOUS_PATIENT'
    - 'LATEST'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'LATEST'
  actual: 'AMBIGUOUS_PATIENT'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/tests/public-api.test.mjs:44:10)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```

### creatinine in different units is refused, not compared

```

---
  duration_ms: 7.797257
  type: 'test'
  location: '/tmp/vm/tests/public-api.test.mjs:116:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    + actual - expected
    
    + 'AMBIGUOUS_PATIENT'
    - 'NOT_COMPARABLE'
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'NOT_COMPARABLE'
  actual: 'AMBIGUOUS_PATIENT'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///tmp/vm/tests/public-api.test.mjs:121:10)
    process.processTicksAndRejections (node:internal/process/task_queues:103:5)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...

```