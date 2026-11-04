# Third held-out set (evaluation/semantic/packets-heldout3.json): written
# after packets.json and packets-heldout2.json had both been used for
# development, before this set was run. Status words still unseen by the
# record layer ("INDICATIVE", "SANCTIONED", "CLOSED"), other wording.
#   python3 evaluation/packets/build3.py
import os, importlib.util
spec = importlib.util.spec_from_file_location("b", os.path.join(os.path.dirname(os.path.abspath(__file__)), "build.py"))
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
Doc = b.Doc

d = Doc("car-service-packet.pdf", "Car service file (fictional)")
ORG = "SPEEDWELL MOTORS SERVICE CENTRE"
y = d.page(ORG, "JOB CARD 4471", "ESTIMATE", "Opened at drop-off")
y = d.table(y, ["WORK", "AMOUNT (INR)"],
            [["Brake pads (front)", "6,400.00"], ["Wheel alignment", "1,200.00"], ["Estimated total", "9,800.00"]],
            [50, 400], gap=26)
y = d.lines(y, ["Promised ready by: 16 Nov 2026, 5 pm", "Service advisor: Rohit Das"])
d.end()
y = d.page(ORG, "TAX INVOICE 4471", "CLOSED / PAID", "Vehicle KA-05-MX-2211")
y = d.table(y, ["WORK", "AMOUNT (INR)"],
            [["Brake pads (front)", "5,900.00"], ["Wheel alignment", "1,200.00"], ["Coolant top-up", "450.00"],
             ["Invoice total", "8,750.00"], ["Amount received", "8,750.00"], ["Balance", "0.00"]],
            [50, 400], gap=26)
y = d.lines(y, ["Vehicle handed over on: 17 Nov 2026", "Odometer at delivery: 48,210 km"])
d.end()
d.save()

d = Doc("home-loan-packet.pdf", "Home loan file (fictional)")
ORG = "SUNRISE HOUSING FINANCE"
y = d.page(ORG, "IN-PRINCIPLE OFFER", "INDICATIVE", "Subject to documents and valuation")
y = d.table(y, ["TERM", "OFFERED"],
            [["Loan amount", "INR 45,00,000"], ["Interest rate", "8.90% p.a."], ["Tenure", "20 years"],
             ["Monthly instalment", "INR 40,200"]], [50, 260], gap=30)
d.end()
y = d.page(ORG, "SANCTION LETTER", "SANCTIONED", "Ref SHF/2026/88120")
y = d.table(y, ["TERM", "SANCTIONED"],
            [["Loan amount", "INR 42,00,000"], ["Interest rate", "8.65% p.a."], ["Tenure", "20 years"],
             ["Monthly instalment", "INR 36,850"], ["Processing fee", "INR 10,000"]], [50, 260], gap=30)
y = d.lines(y, ["Sanctioned by: Neha Kulkarni, Credit Manager", "Offer valid until: 15 Jan 2027"])
d.end()
d.save()
print("built")
