import { parseCleanRecords, EMPTY_CLEAN_RECORD_PAGE } from "../clean-records.js";

/**
 * Fixtures are shaped as the gateway really sends them — the response's `data` object, already
 * unwrapped by the transport, with the array under `clean_record_list` beside a `total`.
 *
 * No real device data: serials, account ids and CDN hosts here are synthetic.
 */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    device_sn: "T8000P0000000000",
    user_id: "0".repeat(40),
    create_time: 1750000000,
    update_time: 1750000060,
    file_path: "clean/record/1.bin",
    download_url: "https://example.invalid/clean/record/1.bin",
    extend: '{"opaque":true}',
    ...over,
  };
}

describe("parseCleanRecords", () => {
  it("returns an empty page for null/undefined/non-object inputs", () => {
    expect(parseCleanRecords(null)).toBe(EMPTY_CLEAN_RECORD_PAGE);
    expect(parseCleanRecords(undefined)).toBe(EMPTY_CLEAN_RECORD_PAGE);
    expect(parseCleanRecords(42)).toBe(EMPTY_CLEAN_RECORD_PAGE);
    expect(parseCleanRecords([])).toBe(EMPTY_CLEAN_RECORD_PAGE);
  });

  it("returns an empty page when the list is absent or not an array", () => {
    expect(parseCleanRecords({})).toBe(EMPTY_CLEAN_RECORD_PAGE);
    expect(parseCleanRecords({ clean_record_list: null })).toBe(EMPTY_CLEAN_RECORD_PAGE);
  });

  it("reads a full record, and reports an empty list as a real answer rather than a failure", () => {
    const page = parseCleanRecords({ clean_record_list: [record()], total: 7 });
    expect(page.total).toBe(7);
    expect(page.records).toEqual([
      {
        id: 1,
        createTime: 1750000000,
        updateTime: 1750000060,
        downloadUrl: "https://example.invalid/clean/record/1.bin",
        filePath: "clean/record/1.bin",
        extend: '{"opaque":true}',
      },
    ]);
    // A device with no history answers a page, not the sentinel — "none yet" is not "could not read".
    expect(parseCleanRecords({ clean_record_list: [], total: 0 })).not.toBe(EMPTY_CLEAN_RECORD_PAGE);
  });

  it("does not surface the account id or the serial the caller already supplied", () => {
    const [only] = parseCleanRecords({ clean_record_list: [record()] }).records;
    expect(only).toBeDefined();
    expect(Object.keys(only!).sort()).toEqual(
      ["createTime", "downloadUrl", "extend", "filePath", "id", "updateTime"].sort(),
    );
  });

  it("accepts numeric strings, since the gateway is inconsistent about them", () => {
    const page = parseCleanRecords({
      clean_record_list: [record({ id: "12", create_time: "1750000000" })],
      total: "3",
    });
    expect(page.records[0]?.id).toBe(12);
    expect(page.records[0]?.createTime).toBe(1750000000);
    expect(page.total).toBe(3);
  });

  it("skips a record with no usable id, keeping the rest of the page", () => {
    // The id is what names the run; a record a caller cannot act on is worse than an absent one.
    const page = parseCleanRecords({
      clean_record_list: [record({ id: undefined }), record({ id: "not-a-number" }), record({ id: 9 })],
      total: 3,
    });
    expect(page.records.map((r) => r.id)).toEqual([9]);
    expect(page.total).toBe(3);
  });

  it("defaults every field except the id, so one odd entry never costs the page", () => {
    const page = parseCleanRecords({ clean_record_list: [{ id: 5 }] });
    expect(page.records[0]).toEqual({
      id: 5,
      createTime: 0,
      updateTime: 0,
      downloadUrl: "",
      filePath: "",
      extend: "",
    });
  });

  it("falls back to the record count when the response states no total", () => {
    const page = parseCleanRecords({ clean_record_list: [record(), record({ id: 2 })] });
    expect(page.total).toBe(2);
  });

  it("ignores non-object entries in the list", () => {
    const page = parseCleanRecords({ clean_record_list: [null, "x", 3, [], record({ id: 4 })] });
    expect(page.records.map((r) => r.id)).toEqual([4]);
  });
});
