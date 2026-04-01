import { createRequire } from "module";

const FY2026_DATA = {
  1: { grossIncomeLimit: 1632, netIncomeLimit: 1255, maxAllotment: 292, standardDeduction: 209 },
  2: { grossIncomeLimit: 2198, netIncomeLimit: 1691, maxAllotment: 536, standardDeduction: 209 },
  3: { grossIncomeLimit: 2764, netIncomeLimit: 2127, maxAllotment: 768, standardDeduction: 209 },
  4: { grossIncomeLimit: 3330, netIncomeLimit: 2563, maxAllotment: 975, standardDeduction: 223 },
  5: { grossIncomeLimit: 3896, netIncomeLimit: 2999, maxAllotment: 1158, standardDeduction: 261 },
  6: { grossIncomeLimit: 4462, netIncomeLimit: 3435, maxAllotment: 1390, standardDeduction: 299 },
  7: { grossIncomeLimit: 5028, netIncomeLimit: 3871, maxAllotment: 1536, standardDeduction: 299 },
  8: { grossIncomeLimit: 5594, netIncomeLimit: 4307, maxAllotment: 1756, standardDeduction: 299 },
};

/**
 * Injects a mock Prisma instance into the CJS require cache so that
 * modules depending on src/lib/prisma get mock data instead of a real DB connection.
 * Returns a CJS-compatible require function for loading source modules.
 */
export function setupPrismaMock(importMetaUrl) {
  const require_ = createRequire(importMetaUrl);
  const prismaPath = require_.resolve("../src/lib/prisma");

  require_.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: {
      federalSnapData: {
        findUnique: ({ where }) => {
          const size = where.fiscalYear_householdSize.householdSize;
          return Promise.resolve(FY2026_DATA[size] || null);
        },
      },
      snapConfig: {
        findUnique: () =>
          Promise.resolve({
            bbce: true,
            grossIncomePct: 130,
            assetLimit: null,
          }),
      },
    },
  };

  return require_;
}

export { FY2026_DATA };
