"use strict";

function parseRow(range) {
  const match = /!A(\d+):[A-Z]+(\d+)$/.exec(range);
  return match ? Number(match[1]) - 1 : null;
}

function createFakeSheets(initialRows = []) {
  const rows = initialRows.map((row) => [...row]);

  return {
    rows,
    spreadsheets: {
      async get() {
        return {
          data: {
            sheets: [{ properties: { sheetId: 0, title: "Attendance" } }],
          },
        };
      },

      async batchUpdate({ requestBody }) {
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
        async get() {
          return { data: { values: rows.map((row) => [...row]) } };
        },

        async update({ range, requestBody }) {
          const rowIndex = parseRow(range);
          if (rowIndex === null) {
            rows.splice(0, requestBody.values.length, ...requestBody.values.map((row) => [...row]));
          } else {
            rows[rowIndex] = [...requestBody.values[0]];
          }
          return { data: {} };
        },

        async append({ requestBody }) {
          rows.push(...requestBody.values.map((row) => [...row]));
          return { data: {} };
        },
      },
    },
  };
}

module.exports = { createFakeSheets };
