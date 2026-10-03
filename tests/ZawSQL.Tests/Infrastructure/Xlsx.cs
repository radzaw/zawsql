using System.Globalization;
using System.IO.Compression;
using System.Security;
using System.Text;

namespace ZawSQL.Tests.Infrastructure;

/// <summary>Builds small .xlsx workbooks the way Excel writes them (shared strings, styles, date serials).</summary>
public static class Xlsx
{
    /// <summary>A cell written as an inline string instead of a shared one.</summary>
    public sealed record Inline(string Text);

    /// <summary>
    /// Cells: string (shared string), Inline, int/long/double/decimal (number), bool, DateTime (serial number with a date
    /// style; with a time part, a date-time style), null (cell omitted).
    /// </summary>
    public static byte[] Build(params (string name, object?[][] rows)[] sheets)
    {
        var shared = new List<string>();
        var ms = new MemoryStream();
        using (var zip = new ZipArchive(ms, ZipArchiveMode.Create, leaveOpen: true))
        {
            void Add(string path, string xml)
            {
                using var w = new StreamWriter(zip.CreateEntry(path).Open(), new UTF8Encoding(false));
                w.Write(xml);
            }

            Add("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>""");
            var sheetList = new StringBuilder();
            var rels = new StringBuilder();
            for (var s = 0; s < sheets.Length; s++)
            {
                sheetList.Append($"""<sheet name="{SecurityElement.Escape(sheets[s].name)}" sheetId="{s + 1}" r:id="rId{s + 1}"/>""");
                rels.Append($"""<Relationship Id="rId{s + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{s + 1}.xml"/>""");
                Add($"xl/worksheets/sheet{s + 1}.xml", Sheet(sheets[s].rows, shared));
            }
            Add("xl/workbook.xml", $"""<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets>{sheetList}</sheets></workbook>""");
            Add("xl/_rels/workbook.xml.rels", $"""<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>""");
            // Style 0: general; 1: built-in date (14); 2: custom date-time (164).
            Add("xl/styles.xml", """<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\-mm\-dd\ hh:mm:ss"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>""");
            var sst = new StringBuilder();
            foreach (var t in shared) sst.Append($"<si><t xml:space=\"preserve\">{SecurityElement.Escape(t)}</t></si>");
            Add("xl/sharedStrings.xml", $"""<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{shared.Count}" uniqueCount="{shared.Count}">{sst}</sst>""");
        }
        return ms.ToArray();
    }

    static string Sheet(object?[][] rows, List<string> shared)
    {
        var sb = new StringBuilder("""<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>""");
        for (var r = 0; r < rows.Length; r++)
        {
            sb.Append($"<row r=\"{r + 1}\">");
            for (var c = 0; c < rows[r].Length; c++)
            {
                var v = rows[r][c];
                if (v == null) continue;
                var cellRef = Col(c) + (r + 1);
                switch (v)
                {
                    case string s:
                        var i = shared.IndexOf(s);
                        if (i < 0) { i = shared.Count; shared.Add(s); }
                        sb.Append($"<c r=\"{cellRef}\" t=\"s\"><v>{i}</v></c>");
                        break;
                    case Inline x: sb.Append($"<c r=\"{cellRef}\" t=\"inlineStr\"><is><t>{SecurityElement.Escape(x.Text)}</t></is></c>"); break;
                    case bool b: sb.Append($"<c r=\"{cellRef}\" t=\"b\"><v>{(b ? 1 : 0)}</v></c>"); break;
                    case DateTime d:
                        var serial = (d - new DateTime(1899, 12, 30)).TotalDays;
                        sb.Append($"<c r=\"{cellRef}\" s=\"{(d.TimeOfDay == TimeSpan.Zero ? 1 : 2)}\"><v>{serial.ToString(CultureInfo.InvariantCulture)}</v></c>");
                        break;
                    default: sb.Append($"<c r=\"{cellRef}\"><v>{Convert.ToString(v, CultureInfo.InvariantCulture)}</v></c>"); break;
                }
            }
            sb.Append("</row>");
        }
        return sb.Append("</sheetData></worksheet>").ToString();
    }

    static string Col(int i)
    {
        var s = "";
        for (i++; i > 0; i = (i - 1) / 26) s = (char)('A' + (i - 1) % 26) + s;
        return s;
    }
}
