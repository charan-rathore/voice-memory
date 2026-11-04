# Second held-out set (evaluation/semantic/packets-heldout2.json): written
# after packets.json was used for development, before this set was run.
# New domains and wording on purpose, including status words the record
# layer was not written for (CONFIRMED, VERIFIED, PAID IN PART, TENTATIVE).
#   python3 evaluation/packets/build2.py
import os, importlib.util
spec = importlib.util.spec_from_file_location("b", os.path.join(os.path.dirname(os.path.abspath(__file__)), "build.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
Doc = b.Doc

# ------------------------------------------------------------ 1. vet clinic
d = Doc("vet-clinic-packet.pdf", "Paws and Claws veterinary file (fictional)")
ORG = "PAWS AND CLAWS VETERINARY HOSPITAL"
y = d.page(ORG, "BLOOD CHEMISTRY", "PRELIMINARY", "In-house analyser")
y = d.pairs(y, [(("PATIENT NAME", "Bruno"), ("PATIENT ID", "VP-1102")),
                (("SAMPLE COLLECTED", "09 Nov 2026 09:15"), ("REPORT ISSUED", "09 Nov 2026 11:00"))])
y = d.table(y, ["TEST", "RESULT", "UNITS", "REFERENCE", "FLAG"],
            [["Creatinine", "3.8", "mg/dL", "0.5 - 1.8", "H"],
             ["Glucose", "96", "mg/dL", "70 - 140", ""]], [50, 220, 290, 370, 480])
d.end()
y = d.page(ORG, "BLOOD CHEMISTRY", "REVISED REPORT", "Re-run on reference laboratory analyser")
y = d.pairs(y, [(("PATIENT NAME", "Bruno"), ("PATIENT ID", "VP-1102")),
                (("SAMPLE COLLECTED", "09 Nov 2026 09:15"), ("REPORT ISSUED", "10 Nov 2026 08:30"))])
y = d.table(y, ["TEST", "RESULT", "UNITS", "REFERENCE", "FLAG"],
            [["Creatinine", "1.6", "mg/dL", "0.5 - 1.8", ""],
             ["Glucose", "96", "mg/dL", "70 - 140", ""]], [50, 220, 290, 370, 480])
d.end()
y = d.page(ORG, "THYROID PANEL", "FINAL", "Different animal with the same name")
y = d.pairs(y, [(("PATIENT NAME", "Bruno"), ("PATIENT ID", "VP-1187")),
                (("SAMPLE COLLECTED", "01 Nov 2026 14:00"), ("REPORT ISSUED", "02 Nov 2026 10:00"))])
y = d.table(y, ["TEST", "RESULT", "UNITS", "REFERENCE", "FLAG"],
            [["Total T4", "0.6", "ug/dL", "1.0 - 4.0", "L"]], [50, 220, 290, 370, 480])
d.end()
y = d.page(ORG, "WARD NOTES", "TENTATIVE", "Not reviewed by the vet")
y = d.table(y, ["ITEM", "NOTE"],
            [["Expected go-home", "10 Nov 2026"], ["Fluids", "Continue overnight"]], [50, 260], gap=30)
d.end()
y = d.page(ORG, "DISCHARGE SUMMARY", "SIGNED", "Released to owner")
y = d.table(y, ["FIELD", "RECORDED"],
            [["Discharged to owner", "12 Nov 2026"], ["Discharging vet", "Dr. Kavya Menon"],
             ["Home medication", "Renal diet only, no tablets"]], [50, 260], gap=30)
d.end()
y = d.page(ORG, "FEE ESTIMATE", "PROVISIONAL", "Given at admission")
y = d.table(y, ["ITEM", "AMOUNT (INR)"],
            [["Hospital stay", "12,000.00"], ["Laboratory", "3,500.00"], ["Estimated total", "15,500.00"]],
            [50, 400], gap=26)
d.end()
y = d.page(ORG, "FINAL BILL", "FINAL / PAID IN PART", "Owner: S. Pillai")
y = d.table(y, ["ITEM", "AMOUNT (INR)"],
            [["Hospital stay", "9,000.00"], ["Laboratory", "4,200.00"], ["Bill total", "13,200.00"],
             ["Paid at discharge", "8,000.00"], ["Outstanding", "5,200.00"]], [50, 400], gap=26)
d.end()
d.save()

# --------------------------------------------------------- 2. event booking
d = Doc("event-booking-packet.pdf", "Annual dinner booking file (fictional)")
ORG = "GRAND ORCHID HOTEL / ACME EVENTS"
y = d.page(ORG, "BANQUET PROPOSAL", "PROPOSED", "Sales team offer")
y = d.table(y, ["TERM", "OFFERED"],
            [["Event date", "29 Nov 2026"], ["Guests", "150"], ["Package price", "INR 1,95,000"]],
            [50, 260], gap=30)
d.end()
y = d.page(ORG, "BOOKING CONFIRMATION", "CONFIRMED", "Countersigned by the client")
y = d.table(y, ["TERM", "CONFIRMED"],
            [["Event date", "06 Dec 2026"], ["Guests", "120"], ["Package price", "INR 1,60,000"],
             ["Advance paid", "INR 50,000"], ["Remaining amount", "INR 1,10,000"]], [50, 260], gap=30)
y = d.lines(y, ["Confirmed by: Arjun Mehta, Acme Events", "Venue: Orchid Ballroom"])
d.end()
d.save()

# ---------------------------------------------------------- 3. transcript
d = Doc("transcript-packet.pdf", "Semester grade file (fictional)")
ORG = "LAKEVIEW INSTITUTE OF TECHNOLOGY"
y = d.page(ORG, "GRADE SHEET", "PROVISIONAL", "Before re-evaluation")
y = d.table(y, ["COURSE", "GRADE"],
            [["Thermodynamics", "B"], ["Fluid Mechanics", "A"], ["Semester GPA", "8.1"]], [50, 300], gap=28)
d.end()
y = d.page(ORG, "OFFICIAL TRANSCRIPT", "VERIFIED", "Issued by the Registrar")
y = d.table(y, ["COURSE", "GRADE"],
            [["Thermodynamics", "A-"], ["Fluid Mechanics", "A"], ["Semester GPA", "8.4"]], [50, 300], gap=28)
y = d.lines(y, ["Issued by: Office of the Registrar", "Issue date: 20 Nov 2026"])
d.end()
d.save()
print("built")
