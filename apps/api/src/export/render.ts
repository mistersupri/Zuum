import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";

// A tiny document model shared by the DOCX and PDF renderers so both exports stay identical in content.
export type DocBlock =
  | { kind: "title"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "line"; label: string; text: string };

export async function renderDocx(blocks: DocBlock[]): Promise<Buffer> {
  const children = blocks.map((b) => {
    switch (b.kind) {
      case "title":
        return new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: b.text })] });
      case "meta":
        return new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: b.text, color: "555555", size: 20 })] });
      case "heading":
        return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240 }, children: [new TextRun(b.text)] });
      case "para":
        return new Paragraph({ alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 }, children: [new TextRun(b.text)] });
      case "bullet":
        return new Paragraph({ bullet: { level: 0 }, children: [new TextRun(b.text)] });
      case "line":
        return new Paragraph({
          spacing: { after: 100 },
          children: [new TextRun({ text: b.label, bold: true, size: 20 }), new TextRun({ text: `\n${b.text}`, break: 1 })],
        });
    }
  });
  const doc = new Document({
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

export function renderPdf(blocks: DocBlock[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margins: { top: 64, bottom: 64, left: 64, right: 64 } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    for (const b of blocks) {
      switch (b.kind) {
        case "title":
          doc.font("Times-Bold").fontSize(18).text(b.text).moveDown(0.3);
          break;
        case "meta":
          doc.font("Helvetica").fontSize(9).fillColor("#555555").text(b.text).fillColor("#000000").moveDown(1);
          break;
        case "heading":
          doc.moveDown(0.6).font("Times-Bold").fontSize(13).text(b.text).moveDown(0.3);
          break;
        case "para":
          doc.font("Times-Roman").fontSize(11).text(b.text, { align: "justify" }).moveDown(0.5);
          break;
        case "bullet":
          doc.font("Times-Roman").fontSize(11).text(`•  ${b.text}`, { indent: 8 }).moveDown(0.2);
          break;
        case "line":
          doc.font("Helvetica-Bold").fontSize(9).text(b.label);
          doc.font("Times-Roman").fontSize(11).text(b.text).moveDown(0.5);
          break;
      }
    }
    doc.end();
  });
}
