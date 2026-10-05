using System.Collections.Concurrent;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using MySqlConnector;

namespace ZawSQL;

// CSV / Excel import: reading files (CSV with any delimiter and encoding, .xlsx), previewing them with guessed
// column types, and importing rows into a table in batches the UI drives step by step.

public sealed class ImportSourceOptions
{
    /// <summary>Encoding name (utf-8, utf-16le, windows-1250, …); empty = detect.</summary>
    public string? Encoding { get; set; }
    /// <summary>Field delimiter; empty = detect.</summary>
    public string? Delimiter { get; set; }
    /// <summary>Quote character; empty = none.</summary>
    public string? Quote { get; set; } = "\"";
    public bool Header { get; set; } = true;
    public int SkipRows { get; set; }
    /// <summary>Worksheet name (.xlsx); empty = the first one.</summary>
    public string? Sheet { get; set; }
}

public sealed class ImportPreviewRequest
{
    public string FileId { get; set; } = "";
    public ImportSourceOptions Source { get; set; } = new();
    public bool DecimalComma { get; set; }
    /// <summary>YMD, DMY or MDY for dates like 03/04/2024; empty = suggest one from the data.</summary>
    public string? DateOrder { get; set; }
}

public sealed record ImportMapping(int Source, string Column);
public sealed record ImportNewColumn(string Name, string Type);

public sealed class ImportStartRequest
{
    public string FileId { get; set; } = "";
    public ImportSourceOptions Source { get; set; } = new();
    public string Db { get; set; } = "";
    public string Table { get; set; } = "";
    /// <summary>Columns of a table to create; null imports into an existing table.</summary>
    public List<ImportNewColumn>? Create { get; set; }
    /// <summary>With <see cref="Create"/>: add an auto-increment "id" primary key.</summary>
    public bool AddId { get; set; }
    public List<ImportMapping> Mapping { get; set; } = [];
    /// <summary>insert (duplicates are errors), ignore (skip duplicates), replace, update (update existing rows).</summary>
    public string Mode { get; set; } = "insert";
    /// <summary>Empty cells: auto (NULL except in text columns), null, empty.</summary>
    public string Empty { get; set; } = "auto";
    /// <summary>Cell text meaning NULL (\N by default, as LOAD DATA writes it); empty = none.</summary>
    public string? NullText { get; set; } = "\\N";
    public bool DecimalComma { get; set; }
    public string? DateOrder { get; set; }
    public bool StopOnError { get; set; } = true;
    /// <summary>All or nothing: one transaction, rolled back on error or cancel.</summary>
    public bool Transaction { get; set; }
    /// <summary>Empty the table first (TRUNCATE, or DELETE inside a transaction).</summary>
    public bool Truncate { get; set; }
    /// <summary>Only return the SQL that would run.</summary>
    public bool DryRun { get; set; }
}

public sealed record ImportStepRequest(string JobId, int Rows = 5000);
public sealed record ImportStepResult(long Processed, long Total, long Affected, long Warnings, long ErrorCount,
    List<object> Errors, List<object> WarningSamples, bool Done, bool Failed, bool RolledBack);
public sealed record ImportJobRequest(string JobId);

public sealed class ImportFile
{
    public required string Id { get; init; }
    public required string Path { get; init; }
    public required string Name { get; init; }
    public required string Kind { get; init; } // csv | xlsx
    public long Size { get; init; }
}

/// <summary>Uploaded files and running import jobs. Files live in a per-process temp folder removed on exit.</summary>
public sealed class ImportStore : IAsyncDisposable
{
    readonly string dir = Path.Combine(Path.GetTempPath(), "zawsql-import", Environment.ProcessId.ToString(CultureInfo.InvariantCulture));
    readonly ConcurrentDictionary<string, ImportFile> files = new();
    readonly ConcurrentDictionary<string, ImportJob> jobs = new();

    public ImportStore()
    {
        Directory.CreateDirectory(dir);
        // Folders left behind by processes that didn't exit cleanly.
        try
        {
            foreach (var d in Directory.GetDirectories(Path.GetDirectoryName(dir)!))
                if (d != dir && Directory.GetLastWriteTimeUtc(d) < DateTime.UtcNow.AddDays(-1)) Directory.Delete(d, true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public async Task<ImportFile> SaveAsync(Stream body, string name, CancellationToken ct)
    {
        var id = Guid.NewGuid().ToString("n");
        var path = Path.Combine(dir, id);
        await using (var fs = File.Create(path)) await body.CopyToAsync(fs, ct);
        var size = new FileInfo(path).Length;
        var ext = Path.GetExtension(name).ToLowerInvariant();
        if (ext == ".xls") { File.Delete(path); throw new ApiException("Old Excel .xls files can't be read. Save the sheet as .xlsx or CSV."); }
        var zip = false;
        await using (var fs = File.OpenRead(path))
        {
            var head = new byte[4];
            zip = await fs.ReadAsync(head, ct) == 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4;
        }
        if (zip && ext is not (".xlsx" or ".xlsm" or "")) { File.Delete(path); throw new ApiException($"{name} is a ZIP archive, not a CSV or .xlsx file."); }
        var f = new ImportFile { Id = id, Path = path, Name = name, Kind = zip ? "xlsx" : "csv", Size = size };
        files[id] = f;
        return f;
    }

    public ImportFile GetFile(string id) =>
        files.TryGetValue(id, out var f) ? f : throw new ApiException("The import file is gone; choose it again.");

    public void DeleteFile(string id)
    {
        if (!files.TryRemove(id, out var f)) return;
        try { File.Delete(f.Path); } catch (IOException) { }
    }

    public void AddJob(ImportJob job)
    {
        // Jobs the UI abandoned (window closed mid-import) are rolled back after a while.
        foreach (var stale in jobs.Values.Where(j => j.LastUsed < DateTime.UtcNow.AddMinutes(-15)).ToList())
            _ = RemoveJobAsync(stale.Id);
        jobs[job.Id] = job;
    }

    public ImportJob GetJob(string sid, string id) =>
        jobs.TryGetValue(id, out var j) && j.Sid == sid ? j : throw new ApiException("This import is no longer running.");

    public async Task RemoveJobAsync(string id)
    {
        if (jobs.TryRemove(id, out var j)) await j.DisposeAsync();
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var id in jobs.Keys.ToList()) await RemoveJobAsync(id);
        try { Directory.Delete(dir, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

// ---------------------------------------------------------------- reading files

/// <summary>Rows of a file: CSV records or worksheet rows, as strings (null = missing cell).</summary>
public interface IRowSource : IDisposable
{
    string?[]? Next();
}

/// <summary>RFC 4180 CSV: quoted fields with doubled quotes and line breaks; any delimiter; blank lines skipped.</summary>
public sealed class CsvRowSource(TextReader reader, char delimiter, char? quote) : IRowSource
{
    readonly StringBuilder sb = new();

    public string?[]? Next()
    {
        while (true)
        {
            var row = ReadRecord();
            if (row == null) return null;
            if (row.Count == 1 && row[0].Length == 0) continue;
            return [.. row];
        }
    }

    List<string>? ReadRecord()
    {
        var c = reader.Read();
        if (c < 0) return null;
        var fields = new List<string>();
        sb.Clear();
        bool inQuotes = false, quoted = false;
        while (true)
        {
            if (c < 0) { fields.Add(sb.ToString()); return fields; }
            var ch = (char)c;
            if (inQuotes)
            {
                if (ch == quote)
                {
                    if (reader.Peek() == quote) { sb.Append(ch); reader.Read(); }
                    else inQuotes = false;
                }
                else sb.Append(ch);
            }
            else if (ch == quote && sb.Length == 0 && !quoted) { inQuotes = true; quoted = true; }
            else if (ch == delimiter) { fields.Add(sb.ToString()); sb.Clear(); quoted = false; }
            else if (ch == '\r' || ch == '\n')
            {
                if (ch == '\r' && reader.Peek() == '\n') reader.Read();
                fields.Add(sb.ToString());
                return fields;
            }
            else sb.Append(ch);
            c = reader.Read();
        }
    }

    public void Dispose() => reader.Dispose();
}

/// <summary>Streams the rows of one worksheet of an .xlsx workbook.</summary>
public sealed class XlsxRowSource : IRowSource
{
    readonly ZipArchive zip;
    readonly XmlReader xml;
    readonly List<string> shared;
    readonly List<int> styleFormats; // cell style index → number format id
    readonly HashSet<int> dateFormats;
    readonly HashSet<int> timeFormats;
    readonly bool date1904;

    public static List<string> SheetNames(string path)
    {
        using var zip = ZipFile.OpenRead(path);
        return ReadSheets(zip).sheets.Select(s => s.name).ToList();
    }

    public XlsxRowSource(string path, string? sheet)
    {
        zip = ZipFile.OpenRead(path);
        try
        {
            var (sheets, d1904) = ReadSheets(zip);
            date1904 = d1904;
            if (sheets.Count == 0) throw new ApiException("The workbook has no worksheets.");
            var s = string.IsNullOrEmpty(sheet) ? sheets[0] : sheets.FirstOrDefault(x => x.name == sheet);
            if (s.path == null) throw new ApiException($"Worksheet \"{sheet}\" was not found.");
            shared = ReadSharedStrings(zip);
            (styleFormats, dateFormats, timeFormats) = ReadStyles(zip);
            var entry = zip.GetEntry(s.path) ?? throw new ApiException($"Worksheet \"{s.name}\" is missing from the file.");
            xml = XmlReader.Create(entry.Open(), new XmlReaderSettings { IgnoreWhitespace = false, DtdProcessing = DtdProcessing.Prohibit });
        }
        catch (InvalidDataException) { zip.Dispose(); throw new ApiException("The .xlsx file is damaged."); }
        catch { zip.Dispose(); throw; }
    }

    static (List<(string name, string path)> sheets, bool date1904) ReadSheets(ZipArchive zip)
    {
        var rels = new Dictionary<string, string>();
        var relEntry = zip.GetEntry("xl/_rels/workbook.xml.rels");
        if (relEntry != null)
        {
            using var r = XmlReader.Create(relEntry.Open());
            while (r.Read())
                if (r.NodeType == XmlNodeType.Element && r.LocalName == "Relationship" && r.GetAttribute("Id") is { } id && r.GetAttribute("Target") is { } target)
                    rels[id] = target.StartsWith('/') ? target.TrimStart('/') : "xl/" + target;
        }
        var sheets = new List<(string, string)>();
        var d1904 = false;
        var wb = zip.GetEntry("xl/workbook.xml") ?? throw new ApiException("This is not an Excel .xlsx workbook.");
        using (var r = XmlReader.Create(wb.Open()))
        {
            while (r.Read())
            {
                if (r.NodeType != XmlNodeType.Element) continue;
                if (r.LocalName == "workbookPr") d1904 = r.GetAttribute("date1904") is "1" or "true";
                if (r.LocalName == "sheet")
                {
                    var rid = r.GetAttribute("id", "http://schemas.openxmlformats.org/officeDocument/2006/relationships");
                    if (rid != null && rels.TryGetValue(rid, out var p)) sheets.Add((r.GetAttribute("name") ?? p, p));
                }
            }
        }
        return (sheets, d1904);
    }

    static List<string> ReadSharedStrings(ZipArchive zip)
    {
        var list = new List<string>();
        var e = zip.GetEntry("xl/sharedStrings.xml");
        if (e == null) return list;
        using var r = XmlReader.Create(e.Open());
        var sb = new StringBuilder();
        var phonetic = 0;
        var positioned = false; // ReadElementContentAsString already moved to the next node
        while (positioned || r.Read())
        {
            positioned = false;
            if (r.NodeType == XmlNodeType.Element)
            {
                if (r.LocalName == "si") sb.Clear();
                else if (r.LocalName == "rPh" && !r.IsEmptyElement) phonetic++;
                else if (r.LocalName == "t" && phonetic == 0 && !r.IsEmptyElement) { sb.Append(r.ReadElementContentAsString()); positioned = true; }
            }
            else if (r.NodeType == XmlNodeType.EndElement)
            {
                if (r.LocalName == "si") list.Add(sb.ToString());
                else if (r.LocalName == "rPh") phonetic--;
            }
        }
        return list;
    }

    static (List<int>, HashSet<int>, HashSet<int>) ReadStyles(ZipArchive zip)
    {
        var formats = new List<int>();
        var dates = new HashSet<int> { 14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57 };
        var times = new HashSet<int> { 18, 19, 20, 21, 45, 46, 47 };
        var e = zip.GetEntry("xl/styles.xml");
        if (e == null) return (formats, dates, times);
        using var r = XmlReader.Create(e.Open());
        var inXfs = false;
        while (r.Read())
        {
            if (r.NodeType == XmlNodeType.Element)
            {
                if (r.LocalName == "numFmt" && int.TryParse(r.GetAttribute("numFmtId"), out var id))
                {
                    var code = Regex.Replace(r.GetAttribute("formatCode") ?? "", "\"[^\"]*\"|\\[[^\\]]*\\]|\\\\.|_.|\\*.", "");
                    var date = Regex.IsMatch(code, "[dmy]", RegexOptions.IgnoreCase) && !Regex.IsMatch(code, "^[#0.,%E+-]*$");
                    var time = Regex.IsMatch(code, "[hs]", RegexOptions.IgnoreCase);
                    if (date || time) dates.Add(id); else dates.Remove(id);
                    if (time && !Regex.IsMatch(code, "[dy]", RegexOptions.IgnoreCase)) times.Add(id);
                }
                else if (r.LocalName == "cellXfs") inXfs = !r.IsEmptyElement;
                else if (inXfs && r.LocalName == "xf") formats.Add(int.TryParse(r.GetAttribute("numFmtId"), out var f) ? f : 0);
            }
            else if (r.NodeType == XmlNodeType.EndElement && r.LocalName == "cellXfs") inXfs = false;
        }
        return (formats, dates, times);
    }

    public string?[]? Next()
    {
        while (xml.Read())
        {
            if (xml.NodeType != XmlNodeType.Element || xml.LocalName != "row") continue;
            var cells = new List<string?>();
            if (xml.IsEmptyElement) continue;
            var depth = xml.Depth;
            var next = 0;
            while (xml.Read() && !(xml.NodeType == XmlNodeType.EndElement && xml.Depth == depth))
            {
                if (xml.NodeType != XmlNodeType.Element || xml.LocalName != "c") continue;
                var col = ColumnIndex(xml.GetAttribute("r")) ?? next;
                next = col + 1;
                var t = xml.GetAttribute("t");
                var s = int.TryParse(xml.GetAttribute("s"), out var si) ? si : 0;
                string? raw = null;
                if (!xml.IsEmptyElement)
                {
                    var cd = xml.Depth;
                    var sb = new StringBuilder();
                    var got = false;
                    while (xml.Read() && !(xml.NodeType == XmlNodeType.EndElement && xml.Depth == cd))
                    {
                        if (xml.NodeType == XmlNodeType.Element && (xml.LocalName == "v" || xml.LocalName == "t") && !xml.IsEmptyElement)
                        {
                            sb.Append(xml.ReadElementContentAsString());
                            got = true;
                            if (xml.NodeType == XmlNodeType.EndElement && xml.Depth == cd) break;
                        }
                    }
                    if (got) raw = sb.ToString();
                }
                while (cells.Count < col) cells.Add(null);
                cells.Add(CellValue(raw, t, s));
            }
            if (cells.Any(c => !string.IsNullOrEmpty(c))) return [.. cells];
        }
        return null;
    }

    string? CellValue(string? raw, string? type, int style)
    {
        if (raw == null) return null;
        switch (type)
        {
            case "s": return int.TryParse(raw, out var i) && i >= 0 && i < shared.Count ? shared[i] : null;
            case "b": return raw == "1" ? "TRUE" : "FALSE";
            case "str": case "inlineStr": case "e": case "d": return raw;
        }
        var fmt = style < styleFormats.Count ? styleFormats[style] : 0;
        if (dateFormats.Contains(fmt) && double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var serial))
        {
            var dt = (date1904 ? new DateTime(1904, 1, 1) : new DateTime(1899, 12, 30)).AddDays(serial);
            dt = new DateTime(dt.Ticks - dt.Ticks % TimeSpan.TicksPerSecond + (dt.Millisecond >= 500 ? TimeSpan.TicksPerSecond : 0));
            if (timeFormats.Contains(fmt) && serial < 1) return dt.ToString("HH:mm:ss", CultureInfo.InvariantCulture);
            return dt.TimeOfDay == TimeSpan.Zero && !timeFormats.Contains(fmt)
                ? dt.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                : dt.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture);
        }
        return NormalizeNumber(raw);
    }

    /// <summary>Excel stores numbers like 1E-3; write them out plainly where that is exact.</summary>
    static string NormalizeNumber(string raw)
    {
        if (!raw.Contains('E') && !raw.Contains('e')) return raw;
        return decimal.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d.ToString(CultureInfo.InvariantCulture) : raw;
    }

    static int? ColumnIndex(string? cellRef)
    {
        if (string.IsNullOrEmpty(cellRef)) return null;
        var n = 0;
        foreach (var ch in cellRef)
        {
            if (ch is >= 'A' and <= 'Z') n = n * 26 + (ch - 'A' + 1);
            else break;
        }
        return n > 0 ? n - 1 : null;
    }

    public void Dispose()
    {
        xml.Dispose();
        zip.Dispose();
    }
}

/// <summary>A file opened with its options: skipped rows and the header row consumed, data rows numbered.</summary>
public sealed class SourceReader : IDisposable
{
    readonly IRowSource src;
    public string[] Header { get; private set; } = [];
    /// <summary>1-based record number in the file of the last data row returned (header and skipped rows counted).</summary>
    public long RowNumber { get; private set; }
    public string? Encoding { get; private init; }
    public string? Delimiter { get; private init; }

    SourceReader(IRowSource src) => this.src = src;

    public static SourceReader Open(ImportFile f, ImportSourceOptions o)
    {
        SourceReader r;
        if (f.Kind == "xlsx") r = new SourceReader(new XlsxRowSource(f.Path, o.Sheet));
        else
        {
            var enc = string.IsNullOrEmpty(o.Encoding) ? Importer.DetectEncoding(f.Path) : Importer.GetEncoding(o.Encoding);
            var quote = string.IsNullOrEmpty(o.Quote) ? (char?)null : o.Quote[0];
            var delim = string.IsNullOrEmpty(o.Delimiter) ? Importer.DetectDelimiter(f.Path, enc, quote) : o.Delimiter == "\\t" ? '\t' : o.Delimiter[0];
            var reader = new StreamReader(f.Path, enc, detectEncodingFromByteOrderMarks: true, new FileStreamOptions { BufferSize = 1 << 16 });
            r = new SourceReader(new CsvRowSource(reader, delim, quote)) { Encoding = enc.WebName, Delimiter = delim.ToString() };
        }
        try
        {
            for (var i = 0; i < Math.Max(0, o.SkipRows); i++)
            {
                if (r.src.Next() == null) break;
                r.RowNumber++;
            }
            if (o.Header)
            {
                var h = r.src.Next();
                if (h != null) r.RowNumber++;
                r.Header = (h ?? []).Select(x => x ?? "").ToArray();
            }
        }
        catch { r.Dispose(); throw; }
        return r;
    }

    public string?[]? Next()
    {
        var row = src.Next();
        if (row != null) RowNumber++;
        return row;
    }

    public void Dispose() => src.Dispose();
}

// ---------------------------------------------------------------- analysis, conversion, SQL

public static partial class Importer
{
    public static readonly string[] Encodings = ["utf-8", "utf-16le", "utf-16be", "windows-1250", "windows-1252", "iso-8859-1", "iso-8859-2"];

    public static Encoding GetEncoding(string name)
    {
        try { return name.ToLowerInvariant() is "utf-8" or "utf8" ? new UTF8Encoding(false) : System.Text.Encoding.GetEncoding(name); }
        catch (ArgumentException) { throw new ApiException($"Unknown encoding: {name}"); }
    }

    /// <summary>BOM, else UTF-8 when the start of the file is valid UTF-8, else Windows-1252.</summary>
    public static Encoding DetectEncoding(string path)
    {
        var buf = new byte[1 << 20];
        int n;
        using (var fs = File.OpenRead(path)) n = fs.ReadAtLeast(buf, buf.Length, throwOnEndOfStream: false);
        if (n >= 3 && buf[0] == 0xEF && buf[1] == 0xBB && buf[2] == 0xBF) return new UTF8Encoding(false);
        if (n >= 2 && buf[0] == 0xFF && buf[1] == 0xFE) return System.Text.Encoding.Unicode;
        if (n >= 2 && buf[0] == 0xFE && buf[1] == 0xFF) return System.Text.Encoding.BigEndianUnicode;
        // Don't fail on a multi-byte character cut off at the end of the sample.
        var end = n;
        if (n == buf.Length)
            for (var k = 1; k <= 3 && end > 0 && (buf[end - 1] & 0xC0) == 0x80; k++) end--;
        if (n == buf.Length && end > 0 && (buf[end - 1] & 0xC0) == 0xC0) end--;
        try
        {
            new UTF8Encoding(false, true).GetCharCount(buf, 0, end);
            return new UTF8Encoding(false);
        }
        catch (DecoderFallbackException)
        {
            return System.Text.Encoding.GetEncoding(1252);
        }
    }

    /// <summary>The candidate (, ; tab |) that splits the first records into the most consistent number of fields.</summary>
    public static char DetectDelimiter(string path, Encoding enc, char? quote)
    {
        string sample;
        using (var r = new StreamReader(path, enc, true))
        {
            var buf = new char[64 * 1024];
            var n = r.ReadBlock(buf, 0, buf.Length);
            sample = new string(buf, 0, n);
        }
        return DetectDelimiter(sample, quote);
    }

    public static char DetectDelimiter(string sample, char? quote)
    {
        var best = ',';
        var bestScore = -1.0;
        foreach (var cand in new[] { ',', ';', '\t', '|' })
        {
            var counts = new List<int>();
            using (var src = new CsvRowSource(new StringReader(sample), cand, quote))
                for (var i = 0; i < 50 && src.Next() is { } row; i++) counts.Add(row.Length);
            if (counts.Count > 1 && sample.Length >= 64 * 1024) counts.RemoveAt(counts.Count - 1); // may be cut off
            if (counts.Count == 0) continue;
            var mode = counts.GroupBy(c => c).OrderByDescending(g => g.Count()).ThenByDescending(g => g.Key).First();
            if (mode.Key < 2) continue;
            var score = (double)mode.Count() / counts.Count * 1000 + mode.Key;
            if (score > bestScore) { bestScore = score; best = cand; }
        }
        return best;
    }

    // ---- preview

    /// <summary>Numbers as the import would read them with one decimal separator (thousands separators removed).</summary>
    sealed class NumberStats
    {
        public long Ints, Fits32, LeadingZero, Dec;
        public int IntDigits, Frac;
    }

    sealed class ColumnStats
    {
        public long NonEmpty, Bools, Sci, IsoDates, IsoDateTimes, NumDates, NumDateTimes;
        public long DotDec, CommaDec; // as typed: 1.5 / 1,5 (for suggesting the separator)
        public readonly NumberStats Dot = new(), Comma = new();
        public int MaxLen;
        public bool FirstOver12, SecondOver12, DotSeparated;
        public string? Sample;
    }

    [GeneratedRegex(@"^[-+]?\d+$")] private static partial Regex IntRe();
    [GeneratedRegex(@"^[-+]?(\d+)\.(\d+)$")] private static partial Regex DotDecRe();
    [GeneratedRegex(@"^[-+]?(\d+),(\d+)$")] private static partial Regex CommaDecRe();
    [GeneratedRegex(@"^[-+]?\d+(\.\d+)?[eE][-+]?\d+$")] private static partial Regex SciRe();
    [GeneratedRegex(@"^\d{4}-\d{1,2}-\d{1,2}$")] private static partial Regex IsoDateRe();
    [GeneratedRegex(@"^\d{4}-\d{1,2}-\d{1,2}[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$")] private static partial Regex IsoDateTimeRe();
    [GeneratedRegex(@"^(\d{1,4})([./-])(\d{1,2})[./-](\d{1,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?$")] private static partial Regex NumDateRe();

    static void Observe(ColumnStats s, string? v)
    {
        if (string.IsNullOrEmpty(v)) return;
        s.NonEmpty++;
        s.Sample ??= v;
        if (v.Length > s.MaxLen) s.MaxLen = v.Length;
        var t = v.Trim();
        if (t is "TRUE" or "FALSE" or "true" or "false" or "True" or "False") s.Bools++;
        if (t.Length > 0 && (char.IsAsciiDigit(t[0]) || t[0] is '-' or '+' or '.'))
        {
            ObserveNumber(s.Dot, NormalizeNumber(t, false));
            ObserveNumber(s.Comma, NormalizeNumber(t, true));
        }
        if (DotDecRe().IsMatch(t)) s.DotDec++;
        if (CommaDecRe().IsMatch(t)) s.CommaDec++;
        if (SciRe().IsMatch(t)) s.Sci++;
        if (IsoDateRe().IsMatch(t)) s.IsoDates++;
        else if (IsoDateTimeRe().IsMatch(t)) s.IsoDateTimes++;
        else if (NumDateRe().Match(t) is { Success: true } nd && nd.Groups[1].Length <= 2)
        {
            if (nd.Groups[5].Success) s.NumDateTimes++; else s.NumDates++;
            if (int.Parse(nd.Groups[1].Value, CultureInfo.InvariantCulture) > 12) s.FirstOver12 = true;
            if (int.Parse(nd.Groups[3].Value, CultureInfo.InvariantCulture) > 12) s.SecondOver12 = true;
            if (nd.Groups[2].Value == ".") s.DotSeparated = true;
        }
    }

    static void ObserveNumber(NumberStats n, string f)
    {
        var digits = f.TrimStart('-', '+');
        if (IntRe().IsMatch(f))
        {
            n.Ints++;
            if (int.TryParse(f, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out _)) n.Fits32++;
            if (digits.Length > 1 && digits[0] == '0') n.LeadingZero++;
            n.IntDigits = Math.Max(n.IntDigits, digits.Length);
        }
        else if (DotDecRe().Match(f) is { Success: true } d)
        {
            n.Dec++;
            if (d.Groups[1].Length > 1 && d.Groups[1].Value[0] == '0') n.LeadingZero++;
            n.IntDigits = Math.Max(n.IntDigits, d.Groups[1].Length);
            n.Frac = Math.Max(n.Frac, d.Groups[2].Length);
        }
    }

    static string GuessType(ColumnStats s, bool decimalComma, string? dateOrder)
    {
        var n = s.NonEmpty;
        if (n == 0) return "VARCHAR(255)";
        if (s.Bools == n) return "TINYINT(1)";
        var num = decimalComma ? s.Comma : s.Dot;
        if (num.Ints == n && num.LeadingZero == 0)
            return num.Fits32 == n ? "INT" : num.IntDigits <= 18 ? "BIGINT" : num.IntDigits <= 65 ? $"DECIMAL({num.IntDigits},0)" : Text(s);
        if (num.LeadingZero == 0 && num.Dec > 0 && num.Ints + num.Dec == n)
        {
            var frac = Math.Min(num.Frac, 30);
            var precision = Math.Max(num.IntDigits + frac, frac + 1);
            return precision <= 65 ? $"DECIMAL({precision},{frac})" : "DOUBLE";
        }
        if (s.Sci > 0 && s.Sci + s.Dot.Ints + s.Dot.Dec == n) return "DOUBLE";
        if (s.IsoDates == n) return "DATE";
        if (s.IsoDates + s.IsoDateTimes == n) return "DATETIME";
        if (!string.IsNullOrEmpty(dateOrder) && s.NumDates + s.NumDateTimes == n) return s.NumDateTimes > 0 ? "DATETIME" : "DATE";
        return Text(s);
    }

    static string Text(ColumnStats s)
    {
        if (s.MaxLen > 4_000_000) return "LONGTEXT";
        if (s.MaxLen > 16_000) return "MEDIUMTEXT";
        if (s.MaxLen > 2048) return "TEXT";
        // Leave some room for longer values added later: data filling more than 80% gets the next size.
        foreach (var size in new[] { 16, 32, 64, 128, 255, 512, 1024, 2048 })
            if (s.MaxLen <= size * 4 / 5) return $"VARCHAR({size})";
        return "TEXT";
    }

    /// <summary>Column names for a new table: trimmed, at most 64 characters, unique, never empty.</summary>
    public static string[] ColumnNames(IReadOnlyList<string> header, int width)
    {
        var names = new string[width];
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < width; i++)
        {
            var b = i < header.Count ? Regex.Replace(header[i] ?? "", @"\s+", " ").Trim().TrimEnd('.') : "";
            if (b.Length == 0) b = $"column_{i + 1}";
            if (b.Length > 64) b = b[..64].TrimEnd();
            var name = b;
            for (var k = 2; !seen.Add(name); k++) name = (b.Length > 60 ? b[..60] : b) + "_" + k;
            names[i] = name;
        }
        return names;
    }

    /// <summary>Header, first rows, row count and a guessed type per column. Counting stops after a few seconds on huge files.</summary>
    public static object Preview(ImportFile f, ImportPreviewRequest req, int maxRows = 100)
    {
        using var src = SourceReader.Open(f, req.Source);
        var rows = new List<string?[]>();
        var stats = new List<ColumnStats>();
        long total = 0;
        var complete = true;
        var deadline = DateTime.UtcNow.AddSeconds(4);
        while (src.Next() is { } row)
        {
            total++;
            if (rows.Count < maxRows) rows.Add(row);
            while (stats.Count < row.Length) stats.Add(new ColumnStats());
            for (var i = 0; i < row.Length; i++) Observe(stats[i], row[i]);
            if ((total & 1023) == 0 && DateTime.UtcNow > deadline) { complete = false; break; }
        }
        var width = Math.Max(src.Header.Length, stats.Count);
        while (stats.Count < width) stats.Add(new ColumnStats());

        string? dateOrder = req.DateOrder;
        string? suggestedOrder = null;
        if (stats.Any(s => s.NumDates + s.NumDateTimes > 0))
            suggestedOrder = stats.Any(s => s.SecondOver12) && !stats.Any(s => s.FirstOver12) ? "MDY"
                : stats.Any(s => s.FirstOver12 || s.DotSeparated) ? "DMY" : "MDY";
        if (string.IsNullOrEmpty(dateOrder)) dateOrder = suggestedOrder;
        var suggestComma = stats.Sum(s => s.CommaDec) > 0 && stats.Sum(s => s.DotDec) == 0 && src.Delimiter != ",";

        var names = ColumnNames(src.Header, width);
        return new
        {
            kind = f.Kind,
            name = f.Name,
            size = f.Size,
            encoding = src.Encoding,
            delimiter = src.Delimiter,
            sheets = f.Kind == "xlsx" ? XlsxRowSource.SheetNames(f.Path) : null,
            header = src.Header,
            columns = names.Select((n, i) => new { name = n, type = GuessType(stats[i], req.DecimalComma, dateOrder), sample = stats[i].Sample }).ToArray(),
            rows,
            totalRows = total,
            complete,
            suggestedDateOrder = suggestedOrder,
            suggestedDecimalComma = suggestComma,
        };
    }

    public static long CountRows(ImportFile f, ImportSourceOptions o)
    {
        using var src = SourceReader.Open(f, o);
        long n = 0;
        while (src.Next() != null) n++;
        return n;
    }

    // ---- conversion

    public enum Category { Text, Number, Bit, Date, DateTime, Time, Other }

    public static Category CategoryOf(string type)
    {
        var t = type.ToLowerInvariant();
        if (Regex.IsMatch(t, @"^(tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|fixed|float|double|real|bool|boolean|year)\b")) return Category.Number;
        if (t.StartsWith("bit", StringComparison.Ordinal)) return Category.Bit;
        if (t.StartsWith("datetime", StringComparison.Ordinal) || t.StartsWith("timestamp", StringComparison.Ordinal)) return Category.DateTime;
        if (t.StartsWith("date", StringComparison.Ordinal)) return Category.Date;
        if (t.StartsWith("time", StringComparison.Ordinal)) return Category.Time;
        if (Regex.IsMatch(t, @"^(char|varchar|tinytext|text|mediumtext|longtext|enum|set|json)\b")) return Category.Text;
        return Category.Other;
    }

    [GeneratedRegex(@"^[-+]?\d{1,3}(\.\d{3})+(,\d+)?$")] private static partial Regex DotThousandsRe();
    [GeneratedRegex(@"^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$")] private static partial Regex CommaThousandsRe();

    public static string NormalizeNumber(string v, bool decimalComma)
    {
        var s = v.Trim().Replace(" ", "").Replace(" ", "").Replace(" ", "");
        switch (s.ToLowerInvariant())
        {
            case "true" or "yes": return "1";
            case "false" or "no": return "0";
        }
        if (decimalComma)
        {
            if (DotThousandsRe().IsMatch(s)) s = s.Replace(".", "");
            return s.Replace(',', '.');
        }
        return CommaThousandsRe().IsMatch(s) ? s.Replace(",", "") : s;
    }

    /// <summary>Dates as MySQL wants them (YYYY-MM-DD[ HH:MM:SS]); values it can't read are left for MySQL to judge.</summary>
    public static string NormalizeDate(string v, string? order)
    {
        var s = v.Trim();
        if (IsoDateRe().IsMatch(s) || IsoDateTimeRe().IsMatch(s)) return s.Replace('T', ' ');
        var m = NumDateRe().Match(s);
        if (!m.Success) return s;
        int a = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture), b = int.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture),
            c = int.Parse(m.Groups[4].Value, CultureInfo.InvariantCulture);
        int y, mo, d;
        if (m.Groups[1].Length == 4 || order == "YMD") (y, mo, d) = (a, b, c);
        else if (order == "MDY") (y, mo, d) = (c, a, b);
        else if (order == "DMY") (y, mo, d) = (c, b, a);
        else return s;
        if (m.Groups[1].Length != 4 && m.Groups[4].Length <= 2) y += y < 70 ? 2000 : 1900;
        var date = $"{y:D4}-{mo:D2}-{d:D2}";
        if (!m.Groups[5].Success) return date;
        var sec = m.Groups[7].Success ? m.Groups[7].Value : "00";
        return $"{date} {int.Parse(m.Groups[5].Value, CultureInfo.InvariantCulture):D2}:{m.Groups[6].Value}:{sec}{m.Groups[8].Value}";
    }

    /// <summary>One cell as an SQL literal for a column of the given category.</summary>
    public static string Literal(string? v, Category cat, ImportStartRequest o)
    {
        if (v == null) return "NULL";
        if (!string.IsNullOrEmpty(o.NullText) && v == o.NullText) return "NULL";
        if (v.Length == 0)
        {
            return o.Empty switch
            {
                "null" => "NULL",
                "empty" => "''",
                _ => cat is Category.Text or Category.Other ? "''" : "NULL",
            };
        }
        switch (cat)
        {
            case Category.Number: return SqlLiteral.Quote(NormalizeNumber(v, o.DecimalComma));
            case Category.Bit:
            {
                var n = NormalizeNumber(v, false);
                return Regex.IsMatch(n, @"^\d+$") ? n : SqlLiteral.Quote(n);
            }
            case Category.Date: case Category.DateTime: return SqlLiteral.Quote(NormalizeDate(v, o.DateOrder));
            case Category.Time: return SqlLiteral.Quote(v.Trim());
            default: return SqlLiteral.Quote(v);
        }
    }

    [GeneratedRegex(@"^[A-Za-z][A-Za-z0-9_ (),'.]*$")] private static partial Regex TypeRe();

    public static string CreateTableSql(string db, string table, List<ImportNewColumn> cols, bool addId)
    {
        if (cols.Count == 0) throw new ApiException("The new table needs at least one column.");
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var defs = new List<string>();
        if (addId)
        {
            seen.Add("id");
            defs.Add("`id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY");
        }
        foreach (var c in cols)
        {
            var name = c.Name.Trim();
            if (name.Length == 0 || name.Length > 64) throw new ApiException($"Column name \"{c.Name}\" must have 1 to 64 characters.");
            if (!seen.Add(name)) throw new ApiException($"Column \"{name}\" appears twice.");
            var type = c.Type.Trim();
            if (!TypeRe().IsMatch(type)) throw new ApiException($"\"{c.Type}\" is not a valid column type (column {name}).");
            defs.Add($"{Db.Q(name)} {type} NULL");
        }
        return $"CREATE TABLE {Db.Q(db, table)} (\n  {string.Join(",\n  ", defs)}\n)";
    }
}

/// <summary>A running import: its own connection (and transaction), the open file and counters.</summary>
public sealed class ImportJob : IAsyncDisposable
{
    const int BatchRows = 500;
    const int BatchBytes = 1_000_000;

    public string Id { get; } = Guid.NewGuid().ToString("n");
    public required string Sid { get; init; }
    public required MySqlConnection Conn { get; init; }
    public required SourceReader Source { get; init; }
    public required ImportStartRequest Options { get; init; }
    public required Importer.Category[] Categories { get; init; }
    public required string Head { get; init; }
    public required string Tail { get; init; }
    public required long Total { get; init; }
    public DateTime LastUsed { get; private set; } = DateTime.UtcNow;

    readonly SemaphoreSlim gate = new(1, 1);
    long processed, affected, warnings, errorCount;
    bool done, inTransaction;
    readonly List<object> warningSamples = [];

    public bool InTransaction { set => inTransaction = value; }

    public string Tuple(string?[] row)
    {
        var sb = new StringBuilder("(");
        for (var i = 0; i < Options.Mapping.Count; i++)
        {
            if (i > 0) sb.Append(", ");
            var src = Options.Mapping[i].Source;
            sb.Append(Importer.Literal(src >= 0 && src < row.Length ? row[src] : null, Categories[i], Options));
        }
        return sb.Append(')').ToString();
    }

    public async Task<ImportStepResult> StepAsync(int maxRows, SqlLog log, CancellationToken ct)
    {
        if (!await gate.WaitAsync(0, ct)) throw new ApiException("The import is busy.");
        try
        {
            LastUsed = DateTime.UtcNow;
            if (done) throw new ApiException("This import has finished.");
            var errors = new List<object>();
            var batch = new List<(long row, string tuple)>();
            var size = 0;
            var read = 0;
            var stopped = false;
            var eof = false;
            var firstStep = processed == 0;
            while (read < Math.Clamp(maxRows, 1, 100_000))
            {
                var row = Source.Next();
                if (row == null) { eof = true; break; }
                read++;
                processed++;
                var t = Tuple(row);
                batch.Add((Source.RowNumber, t));
                size += t.Length;
                if (batch.Count >= BatchRows || size >= BatchBytes)
                {
                    if (!await FlushAsync(batch, errors, firstStep ? log : null, ct)) { stopped = true; break; }
                    firstStep = false;
                    batch.Clear();
                    size = 0;
                }
            }
            if (!stopped && batch.Count > 0) stopped = !await FlushAsync(batch, errors, firstStep ? log : null, ct);

            var rolledBack = false;
            if (stopped)
            {
                done = true;
                if (inTransaction) { await Db.ExecAsync(Conn, log, "ROLLBACK", ct); rolledBack = true; inTransaction = false; }
            }
            else if (eof)
            {
                done = true;
                if (inTransaction) { await Db.ExecAsync(Conn, log, "COMMIT", ct); inTransaction = false; }
            }
            if (done) log.Add($"/* Import {(stopped ? "stopped" : "finished")}: {processed:N0} rows read, {affected:N0} affected, {errorCount:N0} errors, {warnings:N0} warnings */");
            var newWarnings = warningSamples.ToList();
            warningSamples.Clear();
            return new ImportStepResult(processed, Total, affected, warnings, errorCount, errors, newWarnings, done, stopped, rolledBack);
        }
        finally
        {
            gate.Release();
        }
    }

    async Task<bool> FlushAsync(List<(long row, string tuple)> batch, List<object> errors, SqlLog? log, CancellationToken ct)
    {
        var sql = Head + string.Join(",\n", batch.Select(b => b.tuple)) + Tail;
        var line = log?.Add(sql.Length > 2000 ? sql[..2000] + $"\n/* … {batch.Count} rows per statement; further statements are not logged */" : sql) ?? -1;
        try
        {
            await ExecAsync(sql, batch[0].row, ct);
            log?.Finish(line);
            return true;
        }
        catch (MySqlException) when (!ct.IsCancellationRequested && Conn.State == System.Data.ConnectionState.Open)
        {
            // Find the rows that fail, one at a time.
            foreach (var (row, tuple) in batch)
            {
                try
                {
                    await ExecAsync(Head + tuple + Tail, row, ct);
                }
                catch (MySqlException ex) when (!ct.IsCancellationRequested && Conn.State == System.Data.ConnectionState.Open)
                {
                    errorCount++;
                    if (errors.Count < 100) errors.Add(new { row, message = ex.Message, code = ex.Number });
                    if (Options.StopOnError) return false;
                }
            }
            return true;
        }
    }

    async Task ExecAsync(string sql, long firstRow, CancellationToken ct)
    {
        await using var cmd = Conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 0;
        affected += await cmd.ExecuteNonQueryAsync(ct);
        var w = long.TryParse(await Db.ScalarAsync(Conn, null, "SELECT @@warning_count", ct), out var n) ? n : 0;
        if (w == 0) return;
        warnings += w;
        if (warningSamples.Count >= 10) return;
        foreach (var r in await Db.RowsAsync(Conn, null, "SHOW WARNINGS LIMIT 5", ct))
            warningSamples.Add(new { row = firstRow, message = r["Message"], code = r["Code"] });
    }

    public async ValueTask DisposeAsync()
    {
        await gate.WaitAsync(TimeSpan.FromSeconds(30)); // let a running step finish (a cancelled request stops it)
        try
        {
            if (inTransaction && Conn.State == System.Data.ConnectionState.Open)
                await Db.ExecAsync(Conn, null, "ROLLBACK", CancellationToken.None);
        }
        catch (MySqlException) { }
        Source.Dispose();
        await Conn.DisposeAsync();
        gate.Dispose();
    }
}

public static partial class Importer
{
    /// <summary>
    /// Validates the request and prepares the target (CREATE TABLE, emptying it, transaction). With DryRun only the SQL
    /// is returned; otherwise a job is registered that <see cref="ImportJob.StepAsync"/> then runs.
    /// </summary>
    public static async Task<object> StartAsync(ImportStore store, ConnectionManager cm, DbSession ses, ImportStartRequest req, SqlLog log, CancellationToken ct)
    {
        if (ses.Profile.ReadOnly) throw new ApiException("This session is in read-only mode; importing is not allowed.");
        var file = store.GetFile(req.FileId);
        if (string.IsNullOrWhiteSpace(req.Db) || string.IsNullOrWhiteSpace(req.Table)) throw new ApiException("Choose a database and a table.");
        if (req.Mapping.Count == 0) throw new ApiException("Map at least one file column to a table column.");
        if (req.Mode is not ("insert" or "ignore" or "replace" or "update")) throw new ApiException($"Unknown import mode: {req.Mode}");
        var dup = req.Mapping.GroupBy(m => m.Column, StringComparer.OrdinalIgnoreCase).FirstOrDefault(g => g.Count() > 1);
        if (dup != null) throw new ApiException($"Column \"{dup.Key}\" is mapped twice.");

        var c = await cm.OpenMetaAsync(ses, ct);
        try
        {
            string? createSql = null;
            List<(string name, string type)> columns;
            if (req.Create != null)
            {
                createSql = CreateTableSql(req.Db, req.Table, req.Create, req.AddId);
                var exists = await Db.ScalarAsync(c, null, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_NAME = @p1", ct, req.Db, req.Table);
                if (exists != "0") throw new ApiException($"Table {req.Db}.{req.Table} already exists. Choose another name, or import into the existing table.");
                columns = req.Create.Select(x => (x.Name.Trim(), x.Type.Trim())).ToList();
            }
            else
            {
                var meta = await TableMeta.LoadAsync(c, null, req.Db, req.Table, ct);
                if (meta.IsView) throw new ApiException($"{req.Db}.{req.Table} is a view; import into a table.");
                var generated = meta.Columns.Where(x => x.IsGenerated).Select(x => x.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
                if (req.Mapping.FirstOrDefault(m => generated.Contains(m.Column)) is { } g) throw new ApiException($"Column \"{g.Column}\" is generated and can't be imported into.");
                columns = meta.Columns.Select(x => (x.Name, x.Type)).ToList();
            }
            var cats = new Category[req.Mapping.Count];
            var names = new string[req.Mapping.Count];
            for (var i = 0; i < req.Mapping.Count; i++)
            {
                var col = columns.FirstOrDefault(x => string.Equals(x.name, req.Mapping[i].Column, StringComparison.OrdinalIgnoreCase));
                if (col.name == null) throw new ApiException($"Table {req.Table} has no column \"{req.Mapping[i].Column}\".");
                names[i] = col.name;
                cats[i] = CategoryOf(col.type);
            }

            var verb = req.Mode switch { "ignore" => "INSERT IGNORE", "replace" => "REPLACE", _ => "INSERT" };
            var head = $"{verb} INTO {Db.Q(req.Db, req.Table)} ({string.Join(", ", names.Select(Db.Q))}) VALUES\n";
            var tail = "";
            if (req.Mode == "update")
            {
                // MySQL 8.0.19+ deprecates VALUES() here in favour of a row alias, which MariaDB doesn't support.
                var version = await Db.ScalarAsync(c, null, "SELECT VERSION()", ct) ?? "";
                var alias = !version.Contains("MariaDB", StringComparison.OrdinalIgnoreCase)
                    && Version.TryParse(Regex.Match(version, @"^\d+\.\d+\.\d+").Value, out var v) && v >= new Version(8, 0, 19);
                tail = alias
                    ? "\nAS zs_new ON DUPLICATE KEY UPDATE " + string.Join(", ", names.Select(n => $"{Db.Q(n)} = zs_new.{Db.Q(n)}"))
                    : "\nON DUPLICATE KEY UPDATE " + string.Join(", ", names.Select(n => $"{Db.Q(n)} = VALUES({Db.Q(n)})"));
            }
            var truncateSql = !req.Truncate ? null : req.Transaction ? $"DELETE FROM {Db.Q(req.Db, req.Table)}" : $"TRUNCATE TABLE {Db.Q(req.Db, req.Table)}";

            if (req.DryRun)
            {
                var sample = new List<string>();
                using (var src = SourceReader.Open(file, req.Source))
                {
                    var probe = new ImportJob { Sid = ses.Id, Conn = c, Source = src, Options = req, Categories = cats, Head = head, Tail = tail, Total = 0 };
                    for (var k = 0; k < 3 && src.Next() is { } row; k++) sample.Add(probe.Tuple(row));
                }
                await c.DisposeAsync();
                return new { createSql, truncateSql, insertSql = sample.Count > 0 ? head + string.Join(",\n", sample) + tail : null };
            }

            var total = CountRows(file, req.Source);
            if (createSql != null) await Db.ExecAsync(c, log, createSql, ct);
            if (truncateSql != null && !req.Transaction) await Db.ExecAsync(c, log, truncateSql, ct);
            if (req.Transaction)
            {
                await Db.ExecAsync(c, log, "START TRANSACTION", ct);
                if (truncateSql != null) await Db.ExecAsync(c, log, truncateSql, ct);
            }
            var job = new ImportJob
            {
                Sid = ses.Id, Conn = c, Source = SourceReader.Open(file, req.Source), Options = req, Categories = cats,
                Head = head, Tail = tail, Total = total, InTransaction = req.Transaction,
            };
            store.AddJob(job);
            log.Add($"/* Importing {total:N0} rows from {file.Name} into {req.Db}.{req.Table} */");
            return new { jobId = job.Id, total };
        }
        catch
        {
            await c.DisposeAsync();
            throw;
        }
    }
}
