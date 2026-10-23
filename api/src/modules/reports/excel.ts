import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';

/*
 * Excel (.xlsx) export for reports. Each sheet is a simple table: a bold
 * header row, then one row per record. Money columns are real numbers with a
 * number format, so the accountant can sum and filter them in Excel.
 */

export type ColumnType = 'text' | 'money' | 'qty' | 'int' | 'rate';

export interface Column {
  key: string;
  header: string;
  type?: ColumnType;
  width?: number;
}

export interface Sheet {
  name: string;
  columns: Column[];
  rows: Record<string, unknown>[];
}

const FORMATS: Partial<Record<ColumnType, string>> = {
  money: '#,##0.00',
  qty: '#,##0.###',
  rate: '0.00',
  int: '0',
};

function cellValue(value: unknown, type: ColumnType | undefined) {
  if (value === null || value === undefined || value === '') return null;
  // Our decimals are exact strings; Excel stores numbers as doubles, which is
  // fine for display/summing of 2-decimal amounts.
  if (type && type !== 'text') return Number(value);
  return String(value);
}

export async function buildWorkbook(sheets: Sheet[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Glass ERP';
  workbook.created = new Date();

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width ?? Math.max(12, c.header.length + 2),
      style: FORMATS[c.type ?? 'text'] ? { numFmt: FORMATS[c.type ?? 'text'] } : {},
    }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of sheet.rows) {
      ws.addRow(
        Object.fromEntries(sheet.columns.map((c) => [c.key, cellValue(row[c.key], c.type)])),
      );
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function sendXlsx(reply: FastifyReply, buffer: Buffer, fileName: string) {
  return reply
    .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    .header(
      'content-disposition',
      `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}.xlsx"`,
    )
    .send(buffer);
}
