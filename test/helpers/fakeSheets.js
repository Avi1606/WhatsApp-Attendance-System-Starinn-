"use strict";

function parseRow(range) {
  const match = /!A(\d+):[A-Z]+(\d+)$/.exec(range);
  return match ? Number(match[1]) - 1 : null;
}

function parseSheet(range) {
  const match = /^'?([^'!]+)'?!/.exec(range);
  return match ? match[1] : "Attendance";
}

function createFakeSheets(initialRows = []) {
  const sheetData = Array.isArray(initialRows)
    ? { Attendance: initialRows.map((row) => [...row]) }
    : Object.fromEntries(Object.entries(initialRows).map(([sheetName, rows]) => [sheetName, rows.map((row) => [...row])]));

  function rowsFor(range) {
    const sheetName = parseSheet(range);
    if (!sheetData[sheetName]) sheetData[sheetName] = [];
    return sheetData[sheetName];
  }

  return {
    rows: sheetData.Attendance || [],
    sheetData,
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: Object.keys(sheetData).map((title, index) => ({ properties: { sheetId: index, title } })),
          },
        };
      },

      async batchUpdate({ requestBody }) {
        const rows = sheetData.Attendance || [];
        for (const request of requestBody.requests || []) {
          const insert = request.insertDimension;
          if (!insert) continue;

          const count = insert.range.endIndex - insert.range.startIndex;
          const emptyRows = Array.from({ length: count }, () => []);
          rows.splice(insert.range.startIndex, 0, ...emptyRows);
        }
        return { data: {} };
      },

      values: {
        async get({ range }) {
          const rows = rowsFor(range);
          return { data: { values: rows.map((row) => [...row]) } };
        },

        async update({ range, requestBody }) {
          const rows = rowsFor(range);
          const rowIndex = parseRow(range);
          if (rowIndex === null) {
            rows.splice(0, requestBody.values.length, ...requestBody.values.map((row) => [...row]));
          } else {
            rows[rowIndex] = [...requestBody.values[0]];
          }
          return { data: {} };
        },

        async append({ range, requestBody }) {
          const rows = rowsFor(range);
          rows.push(...requestBody.values.map((row) => [...row]));
          return { data: {} };
        },
      },
    },
  };
}

module.exports = { createFakeSheets };
