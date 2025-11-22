import xlsx from "xlsx";
import path from "node:path";
import { excelDateToJSDate } from "../utils/dateConverter.js";
import db from "../config/db.js";
import { formatISTDateTimeForSQL } from "../utils/istDateTime.js";

export const handleExcelSheetUpload = async (req, res) => {
  try {
    const adminId = req.query.adminId;

    // verify admin exists
    const [adminRows] = await db.execute(
      "SELECT * FROM admins WHERE adminId = ?",
      [adminId]
    );
    if (adminRows.length === 0) {
      return res.status(400).json({ msg: "Admin Not Found" });
    }
    const filePath = path.resolve("./data.xlsx");
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.SheetNames[0];
    const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheet]);

    const [configRows] = await db.execute(
      `SELECT pointToDiceRollRatio
       FROM moveAdjustmentConfigs
       WHERE pointToDiceRollRatio IS NOT NULL
       ORDER BY createdAt DESC
       LIMIT 1`
    );

    const pointToDiceRollRatio = Number(configRows?.[0]?.pointToDiceRollRatio) || 1;
    const defaultPoints = 100;
    const defaultMoves = defaultPoints * pointToDiceRollRatio;

    for (const row of data) {
      // Get teamName from Excel (handle case variations)
      const teamName = row.TEAMNAME || row.TeamName || row.teamName || row['Team Name'] || null;

      // ==================== TLM ==================== //
      const [tlmRows] = await db.execute(
        "SELECT * FROM tlms WHERE tlmId = ?",
        [row.TLMID]
      );

      if (tlmRows.length > 0) {
        await db.execute(
          `UPDATE tlms SET tlmName=?, password=?, hq=?, zone=?, teamName=?, adminId=?, updatedAt=? WHERE tlmId=?`,
          [row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, teamName, adminId, istDateTimeString, row.TLMID]
        );
      } else {
        await db.execute(
          `INSERT INTO tlms (tlmId, tlmName, password, hq, zone, teamName, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.TLMID, row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, teamName, adminId, istDateTimeString, istDateTimeString]
        );
      }

      // ==================== SLM ==================== //
      const [slmRows] = await db.execute(
        "SELECT * FROM slms WHERE slmId = ?",
        [row.SLMID]
      );

      if (slmRows.length > 0) {
        await db.execute(
          `UPDATE slms SET slmName=?, password=?, hq=?, region=?, zone=?, teamName=?, adminId=?, updatedAt=? WHERE slmId=?`,
          [row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, teamName, adminId, istDateTimeString, row.SLMID]
        );
      } else {
        await db.execute(
          `INSERT INTO slms (slmId, slmName, password, hq, region, zone, teamName, tlmId, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.SLMID, row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, teamName, row.TLMID, adminId, istDateTimeString, istDateTimeString]
        );
      }

      // ==================== FLM ==================== //
      const [flmRows] = await db.execute(
        "SELECT * FROM flms WHERE flmId = ?",
        [row.FLMID]
      );

      if (flmRows.length > 0) {
        await db.execute(
          `UPDATE flms
           SET flmName = ?,
               password = ?,
               hq = ?,
               region = ?,
               zone = ?,
               teamName = ?,
               points = ?,
               currentDiceRollBalance = ?,
               adminId = ?,
               updatedAt = ?
           WHERE flmId = ?`,
          [
            row.FLMNAME,
            row.FLMPASSWORD,
            row.FLMHQ,
            row.FLMREGION,
            row.FLMZONE,
            teamName,
            defaultPoints,
            defaultMoves,
            adminId,
            istDateTimeString,
            row.FLMID,
          ]
        );
      } else {
        await db.execute(
          `INSERT INTO flms (flmId, FlmName, password, hq, region, zone, teamName, slmId, points, currentDiceRollBalance, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.FLMID,
            row.FLMNAME,
            row.FLMPASSWORD,
            row.FLMHQ,
            row.FLMREGION,
            row.FLMZONE,
            teamName,
            row.SLMID,
            defaultPoints,
            defaultMoves,
            adminId,
            istDateTimeString,
            istDateTimeString,
          ]
        );
      }

      // ==================== MR ==================== //
      const [mrRows] = await db.execute(
        "SELECT * FROM mrs WHERE mrId = ?",
        [row.MRID]
      );

      const cleanDOJ = excelDateToJSDate(row.MRDOJ);

      if (mrRows.length > 0) {
        await db.execute(
          `UPDATE mrs SET mrName=?, email=?, password=?, role=?, hq=?, region=?, zone=?, businessUnit=?, dateOfJoining=?, teamName=?, adminId=?, updatedAt=?
           WHERE mrId=?`,
          [
            row.MRNAME,
            row.MREMAIL,
            row.MRPASSWORD,
            row.MRROLE,
            row.MRHQ,
            row.MRREGION,
            row.MRZONE,
            row.MRBUSSINESSUNIT,
            cleanDOJ,
            teamName,
            adminId,
            istDateTimeString,
            row.MRID,
          ]
        );
      } else {
        await db.execute(
          `INSERT INTO mrs (mrId, mrName, email, password, role, hq, region, zone, businessUnit, dateOfJoining, teamName, flmId, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.MRID,
            row.MRNAME,
            row.MREMAIL,
            row.MRPASSWORD,
            row.MRROLE,
            row.MRHQ,
            row.MRREGION,
            row.MRZONE,
            row.MRBUSSINESSUNIT,
            cleanDOJ,
            teamName,
            row.FLMID,
            adminId,
            istDateTimeString,
            istDateTimeString,
          ]
        );
      }
    }

    const updatedAtIST = formatISTDateTimeForSQL();
    await db.execute(
      `UPDATE flms f
       LEFT JOIN (
         SELECT flmId, COUNT(*) AS mrCount
         FROM mrs
         WHERE flmId IS NOT NULL
         GROUP BY flmId
       ) m ON f.flmId = m.flmId
       SET f.mrCount = COALESCE(m.mrCount, 0), f.updatedAt = ?`,
      [updatedAtIST]
    );

    res.status(200).json({
      message: "Data uploaded and saved successfully into MySQL",
      success: true,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Internal Server Error",
      details: error.message,
    });
  } finally {
    await db.end();
  }
};



// export const handleExcelSheetUpload = async (req, res) => {
//   try {
//     const adminId = req.query.adminId;

//     // verify admin exists
//     const [adminRows] = await db.execute(
//       "SELECT * FROM admins WHERE adminId = ?",
//       [adminId]
//     );
//     if (adminRows.length === 0) {
//       return res.status(400).json({ msg: "Admin Not Found" });
//     }
//     const filePath = path.resolve("./data.xlsx");
//     const workbook = xlsx.readFile(filePath);
//     const sheet = workbook.SheetNames[0];
//     const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheet]);

//     for (const row of data) {
//       // ==================== TLM ==================== //
//       const [tlmRows] = await db.execute(
//         "SELECT * FROM tlms WHERE tlmId = ?",
//         [row.TLMID]
//       );

//       if (tlmRows.length > 0) {
//         await db.execute(
//           `UPDATE tlms SET tlmName=?, password=?, hq=?, zone=? WHERE tlmId=?`,
//           [row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, row.TLMID]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO tlms (tlmId, tlmName, password, hq, zone, adminId)
//            VALUES (?, ?, ?, ?, ?, ?)`,
//           [row.TLMID, row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, adminId]
//         );
//       }

//       // ==================== SLM ==================== //
//       const [slmRows] = await db.execute(
//         "SELECT * FROM slms WHERE slmId = ?",
//         [row.SLMID]
//       );

//       if (slmRows.length > 0) {
//         await db.execute(
//           `UPDATE slms SET slmName=?, password=?, hq=?, region=?, zone=? WHERE slmId=?`,
//           [row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, row.SLMID]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO slms (slmId, slmName, password, hq, region, zone, tlmId)
//            VALUES (?, ?, ?, ?, ?, ?, ?)`,
//           [row.SLMID, row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, row.TLMID]
//         );
//       }

//       // ==================== FLM ==================== //
//       const [flmRows] = await db.execute(
//         "SELECT * FROM flms WHERE flmId = ?",
//         [row.FLMID]
//       );

//       if (flmRows.length > 0) {
//         await db.execute(
//           `UPDATE flms SET flmName=?, password=?, hq=?, region=?, zone=? WHERE flmId=?`,
//           [row.FLMNAME, row.FLMPASSWORD, row.FLMHQ, row.FLMREGION, row.FLMZONE, row.FLMID]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO flms (flmId, FlmName, password, hq, region, zone, slmId)
//            VALUES (?, ?, ?, ?, ?, ?, ?)`,
//           [row.FLMID, row.FLMNAME, row.FLMPASSWORD, row.FLMHQ, row.FLMREGION, row.FLMZONE, row.SLMID]
//         );
//       }

//       // ==================== MR ==================== //
//       const [mrRows] = await db.execute(
//         "SELECT * FROM mrs WHERE mrId = ?",
//         [row.MRID]
//       );

//       const cleanDOJ = excelDateToJSDate(row.MRDOJ);

//       if (mrRows.length > 0) {
//         await db.execute(
//           `UPDATE mrs SET mrName=?, email=?, password=?, role=?, hq=?, region=?, zone=?, businessUnit=?, dateOfJoining=?
//            WHERE mrId=?`,
//           [
//             row.MRNAME,
//             row.MREMAIL,
//             row.MRPASSWORD,
//             row.MRROLE,
//             row.MRHQ,
//             row.MRREGION,
//             row.MRZONE,
//             row.MRBUSSINESSUNIT,
//             cleanDOJ,
//             row.MRID,
//           ]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO mrs (mrId, mrName, email, password, role, hq, region, zone, businessUnit, dateOfJoining  , flmId)
//            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//           [
//             row.MRID,
//             row.MRNAME,
//             row.MREMAIL,
//             row.MRPASSWORD,
//             row.MRROLE,
//             row.MRHQ,
//             row.MRREGION,
//             row.MRZONE,
//             row.MRBUSSINESSUNIT,
//             cleanDOJ,
//             row.FLMID,
//           ]
//         );
//       }
//     }

//     res.status(200).json({
//       message: "Data uploaded and saved successfully into MySQL",
//       success: true,
//     });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({
//       error: "Internal Server Error",
//       details: error.message,
//     });
//   } finally {
//     await db.end();
//   }
// };
