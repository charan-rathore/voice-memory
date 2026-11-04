# Held-out consolidated packets for evaluation/semantic/packets.json.
# Fictional. Written to differ from the hospital packet the record layer was
# developed on: other wording ("Date of discharge", "Amount payable",
# "Balance due"), other domains (procurement, a lease), British spelling,
# Indian digit grouping, label: value lines as well as tables, and a second
# same-name patient whose record has a text layer.
#   python3 evaluation/packets/build.py   (reportlab; invariant output)
import os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
W, H = A4


class Doc:
    def __init__(self, name, title):
        self.c = canvas.Canvas(os.path.join(HERE, name), pagesize=A4, invariant=1)
        self.c.setTitle(title)
        self.n = 0
        self.total = 0

    def page(self, org, title, status, sub=None):
        c = self.c
        self.n += 1
        c.setFont("Helvetica", 8)
        c.drawString(40, H - 30, org)
        c.drawRightString(W - 40, H - 30, "FICTIONAL TEST PACKET")
        c.setFont("Helvetica-Bold", 15)
        c.drawString(40, H - 78, title)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(40, H - 96, status)
        if sub:
            c.setFont("Helvetica", 9)
            c.drawString(40, H - 110, sub)
        return H - 145

    def pairs(self, y, rows):
        c = self.c
        for (l1, v1), (l2, v2) in rows:
            c.setFont("Helvetica", 7.5)
            c.drawString(50, y, l1)
            c.drawString(310, y, l2)
            c.setFont("Helvetica", 10)
            c.drawString(50, y - 14, v1)
            c.drawString(310, y - 14, v2)
            y -= 38
        return y - 14

    def table(self, y, head, rows, xs, gap=24):
        c = self.c
        c.setFont("Helvetica-Bold", 8)
        for x, h in zip(xs, head):
            c.drawString(x, y, h)
        y -= gap
        c.setFont("Helvetica", 9.5)
        for r in rows:
            for x, v in zip(xs, r):
                c.drawString(x, y, v)
            y -= gap
        return y - 16

    def lines(self, y, texts, size=10):
        c = self.c
        c.setFont("Helvetica", size)
        for t in texts:
            c.drawString(50, y, t)
            y -= 16
        return y - 8

    def end(self):
        c = self.c
        c.setFont("Helvetica", 7)
        c.drawString(40, 30, "FICTIONAL TEST PACKET - NOT A REAL RECORD")
        c.drawRightString(W - 40, 30, f"Page {self.n}")
        c.showPage()

    def save(self):
        self.c.save()


# ---------------------------------------------------------------- 1. clinic
d = Doc("riverbend-clinic-packet.pdf", "Riverbend Clinic consolidated record (fictional)")
ORG = "RIVERBEND CLINIC"
y = d.page(ORG, "HAEMATOLOGY REPORT", "PROVISIONAL", "First issue")
y = d.pairs(y, [(("PATIENT NAME", "Ravi Kumar"), ("PATIENT ID", "RB-30211")),
                (("SAMPLE COLLECTED", "02 Nov 2026 08:30"), ("REPORT ISSUED", "02 Nov 2026 12:10"))])
y = d.table(y, ["INVESTIGATION", "RESULT", "UNITS", "REFERENCE RANGE", "FLAG"],
            [["Haemoglobin", "8.9", "g/dL", "13.0 - 17.0", "L"],
             ["Platelet count", "210", "10^3/uL", "150 - 400", ""],
             ["HbA1c", "7.4", "%", "4.0 - 5.6", "H"]], [50, 220, 290, 370, 480])
d.end()
y = d.page(ORG, "CARE PLAN - WORKING COPY", "DRAFT / UNSIGNED", "Ward team notes")
y = d.table(y, ["ITEM", "PLAN"],
            [["Planned discharge", "03 Nov 2026"],
             ["Medication under review", "Consider insulin if HbA1c stays high"],
             ["Deposit", "INR 2,000 collected at admission"]], [50, 260], gap=30)
d.end()
y = d.page(ORG, "HAEMATOLOGY REPORT", "CORRECTED REPORT", "Replaces the first issue for the same sample")
y = d.pairs(y, [(("PATIENT NAME", "Ravi Kumar"), ("PATIENT ID", "RB-30211")),
                (("SAMPLE COLLECTED", "02 Nov 2026 08:30"), ("REPORT ISSUED", "03 Nov 2026 09:45"))])
y = d.table(y, ["INVESTIGATION", "RESULT", "UNITS", "REFERENCE RANGE", "FLAG"],
            [["Haemoglobin", "12.9", "g/dL", "13.0 - 17.0", "L"],
             ["Platelet count", "210", "10^3/uL", "150 - 400", ""],
             ["HbA1c", "7.4", "%", "4.0 - 5.6", "H"]], [50, 220, 290, 370, 480])
y = d.lines(y, ["Correction note: the haemoglobin value was mis-keyed in the first issue (8.9)."])
d.end()
y = d.page(ORG, "VITAMIN PANEL", "FINAL", "Outpatient")
y = d.pairs(y, [(("PATIENT NAME", "Ravi Kumar"), ("PATIENT ID", "RB-30244")),
                (("SAMPLE COLLECTED", "28 Oct 2026 10:00"), ("REPORT ISSUED", "28 Oct 2026 16:00"))])
y = d.table(y, ["INVESTIGATION", "RESULT", "UNITS", "REFERENCE RANGE", "FLAG"],
            [["Vitamin B12", "180", "pg/mL", "200 - 900", "L"],
             ["Vitamin D", "31", "ng/mL", "30 - 100", ""]], [50, 220, 290, 370, 480])
y = d.lines(y, ["Different patient: RB-30244 is not RB-30211, although the printed names match."])
d.end()
y = d.page(ORG, "DISCHARGE NOTE", "SIGNED / FINAL", "Attending physician")
y = d.pairs(y, [(("PATIENT NAME", "Ravi Kumar"), ("PATIENT ID", "RB-30211")),
                (("DATE OF ADMISSION", "01 Nov 2026"), ("DATE OF DISCHARGE", "05 Nov 2026"))])
y = d.table(y, ["FIELD", "RECORDED"],
            [["Released home", "05 Nov 2026 at 11:20"],
             ["Discharge medications", "Metformin 500 mg twice daily"],
             ["Insulin", "Not started"],
             ["Signed by", "Dr. Anita Rao, consultant physician"],
             ["Review", "Clinic visit in 2 weeks"]], [50, 260], gap=30)
d.end()
y = d.page(ORG, "PROVISIONAL INVOICE", "ESTIMATE - NOT FINAL", "Prepared at admission")
y = d.table(y, ["SERVICE", "AMOUNT (INR)"],
            [["Room charges", "18,000.00"], ["Laboratory", "4,500.00"],
             ["Pharmacy", "3,200.00"], ["Total estimate", "25,700.00"],
             ["Amount payable by patient", "9,000.00"]], [50, 400], gap=26)
d.end()
y = d.page(ORG, "STATEMENT OF ACCOUNT", "FINAL / ISSUED", "After insurer settlement")
y = d.table(y, ["SERVICE", "AMOUNT (INR)", "NOTE"],
            [["Room charges", "16,000.00", "4 nights"], ["Laboratory", "5,100.00", "incl. repeat sample"],
             ["Pharmacy", "2,950.00", ""], ["Total charges", "24,050.00", "Final"],
             ["Insurer paid", "18,000.00", "Settled 07 Nov"],
             ["Amount payable by patient", "6,050.00", "Due"],
             ["Received from patient", "2,000.00", "Admission deposit"],
             ["Balance due", "4,050.00", "Unpaid as of 08 Nov"]], [50, 300, 420], gap=26)
d.end()
d.save()

# ---------------------------------------------------------- 2. procurement
d = Doc("procurement-packet.pdf", "Office chairs purchase file (fictional)")
ORG = "NORTHWIND SUPPLIES / ACME OFFICES"
y = d.page(ORG, "QUOTATION Q-7781", "DRAFT", "Sent for internal review")
y = d.table(y, ["LINE", "QTY", "AMOUNT (USD)"],
            [["Ergonomic chair", "40", "11,200.00"], ["Delivery and assembly", "1", "1,200.00"],
             ["Quoted total", "", "12,400.00"]], [50, 300, 420], gap=26)
y = d.lines(y, ["Estimated delivery: 10 Nov 2026", "Validity: 30 days"])
d.end()
y = d.page(ORG, "PURCHASE ORDER PO-55120", "APPROVED / SIGNED", "Issued to Northwind Supplies")
y = d.table(y, ["LINE", "QTY", "AMOUNT (USD)"],
            [["Ergonomic chair", "40", "10,800.00"], ["Delivery and assembly", "1", "1,100.00"],
             ["Order total", "", "11,900.00"]], [50, 300, 420], gap=26)
y = d.lines(y, ["Approved by: Priya Nair, Head of Procurement", "Approval date: 03 Nov 2026"])
d.end()
y = d.page(ORG, "DELIVERY NOTE DN-901", "SIGNED", "Received at Acme Offices, 4th floor")
y = d.table(y, ["FIELD", "RECORDED"],
            [["Delivered on", "14 Nov 2026"], ["Items received", "40 chairs, 0 damaged"],
             ["Received by", "Tom Becker, facilities"]], [50, 260], gap=30)
d.end()
y = d.page(ORG, "INVOICE INV-2209", "FINAL / POSTED", "Against PO-55120")
y = d.table(y, ["ITEM", "AMOUNT (USD)", "STATUS"],
            [["Invoice total", "11,900.00", "Posted"], ["Paid to date", "5,000.00", "Transfer 18 Nov"],
             ["Balance due", "6,900.00", "Due 18 Dec 2026"]], [50, 300, 420], gap=26)
d.end()
d.save()

# ------------------------------------------------------------------ 3. lease
d = Doc("lease-packet.pdf", "Flat 4B lease file (fictional)")
ORG = "LAKESHORE HOMES"
y = d.page(ORG, "LEASE AGREEMENT", "SIGNED", "Flat 4B, Lakeshore Towers")
y = d.table(y, ["TERM", "AGREED"],
            [["Monthly rent", "INR 45,000"], ["Security deposit", "INR 1,35,000"],
             ["Lease start", "01 Jan 2026"], ["Signed by", "Meera Iyer (tenant), K. Shah (owner)"]],
            [50, 260], gap=30)
d.end()
y = d.page(ORG, "RENEWAL PROPOSAL", "DRAFT / NOT APPROVED", "Owner's opening offer")
y = d.table(y, ["TERM", "PROPOSED"],
            [["Monthly rent", "INR 52,000"], ["Renewal from", "01 Jan 2027"]], [50, 260], gap=30)
d.end()
y = d.page(ORG, "ADDENDUM 1", "EXECUTED", "Agreed by both parties")
y = d.table(y, ["TERM", "AGREED"],
            [["Monthly rent", "INR 48,000"], ["Effective from", "01 Jan 2027"],
             ["Security deposit", "INR 1,35,000 (unchanged)"]], [50, 260], gap=30)
d.end()
d.save()
print("built")
