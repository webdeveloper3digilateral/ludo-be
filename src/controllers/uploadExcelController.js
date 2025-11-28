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

    // Commented out: Default points and dice rolls will be provided using the new APIs (giveDiceRollsToRole, giveDiceRollsToPlayers)
    // const [configRows] = await db.execute(
    //   `SELECT pointToDiceRollRatio
    //    FROM config
    //    WHERE pointToDiceRollRatio IS NOT NULL
    //    ORDER BY createdAt DESC
    //    LIMIT 1`
    // );

    // const pointToDiceRollRatio = Number(configRows?.[0]?.pointToDiceRollRatio) || 1;
    // const defaultPoints = 100;
    // const defaultMoves = defaultPoints * pointToDiceRollRatio;

    for (const row of data) {
      // Get team names from Excel (handle case variations)
      // If field is missing or empty, it will be null and skipped in updates
      const tlmTeamName = row.TLMTEAMNAME || row.TlmTeamName || row.tlmteamname || row['TLM Team Name'] || row['Tlm Team Name'] || null;
      const slmTeamName = row.SLMTEAMNAME || row.SlmTeamName || row.slmteamname || row['SLM Team Name'] || row['Slm Team Name'] || null;
      const flmTeamName = row.FLMTEAMNAME || row.FlmTeamName || row.flmteamname || row['FLM Team Name'] || row['Flm Team Name'] || null;
      const mrTeamName = row.MRTEAMNAME || row.MrTeamName || row.mrteamname || row['MR Team Name'] || row['Mr Team Name'] || null;

      // Helper function to check if a value is valid (not null, not empty string, not undefined)
      const isValidValue = (value) => {
        return value !== null && value !== undefined && value !== "" && String(value).trim() !== "";
      };

      // ==================== TLM ==================== //
      const [tlmRows] = await db.execute(
        "SELECT * FROM tlms WHERE tlmId = ?",
        [row.TLMID]
      );

      let finalTlmTeamName = null;
      if (tlmRows.length > 0) {
        // Only update teamName if it's provided in Excel
        if (isValidValue(tlmTeamName)) {
          finalTlmTeamName = tlmTeamName;
          await db.execute(
            `UPDATE tlms SET tlmName=?, password=?, hq=?, zone=?, teamName=?, adminId=?, updatedAt=NOW() WHERE tlmId=?`,
            [row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, tlmTeamName, adminId, row.TLMID]
          );
        } else {
          // Skip teamName update if not provided, but keep existing value for inheritance
          finalTlmTeamName = tlmRows[0].teamName;
        await db.execute(
            `UPDATE tlms SET tlmName=?, password=?, hq=?, zone=?, adminId=?, updatedAt=NOW() WHERE tlmId=?`,
            [row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, adminId, row.TLMID]
        );
        }
      } else {
        // For INSERT, use teamName if provided, otherwise null
        finalTlmTeamName = isValidValue(tlmTeamName) ? tlmTeamName : null;
        await db.execute(
          `INSERT INTO tlms (tlmId, tlmName, password, hq, zone, teamName, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [row.TLMID, row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, finalTlmTeamName, adminId]
        );
      }

      // ==================== SLM ==================== //
      // Hierarchy: If SLM doesn't have teamName in Excel, inherit from TLM (top-down)
      const [slmRows] = await db.execute(
        "SELECT * FROM slms WHERE slmId = ?",
        [row.SLMID]
      );

      // Determine SLM's teamName: Excel value takes priority, otherwise inherit from TLM
      let finalSlmTeamName = null;
      if (isValidValue(slmTeamName)) {
        finalSlmTeamName = slmTeamName; // Excel value takes priority
      } else {
        // Try to inherit from TLM: first from current row's TLM, then from database
        if (isValidValue(finalTlmTeamName)) {
          finalSlmTeamName = finalTlmTeamName; // Inherit from TLM in current row (top-down)
        } else if (row.TLMID) {
          // If TLM didn't have teamName in Excel, check database for TLM's teamName
          const [tlmCheckRows] = await db.execute(
            "SELECT teamName FROM tlms WHERE tlmId = ?",
            [row.TLMID]
          );
          if (tlmCheckRows.length > 0 && isValidValue(tlmCheckRows[0].teamName)) {
            finalSlmTeamName = tlmCheckRows[0].teamName; // Inherit from TLM in database
          }
        }
      }

      if (slmRows.length > 0) {
        // Update teamName if we have a value (from Excel or inherited)
        if (isValidValue(finalSlmTeamName)) {
          await db.execute(
            `UPDATE slms SET slmName=?, password=?, hq=?, region=?, zone=?, teamName=?, adminId=?, updatedAt=NOW() WHERE slmId=?`,
            [row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, finalSlmTeamName, adminId, row.SLMID]
          );
        } else {
          // Skip teamName update if not provided and no inheritance
        await db.execute(
            `UPDATE slms SET slmName=?, password=?, hq=?, region=?, zone=?, adminId=?, updatedAt=NOW() WHERE slmId=?`,
            [row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, adminId, row.SLMID]
        );
        }
      } else {
        // For INSERT, use teamName if provided or inherited, otherwise null
        await db.execute(
          `INSERT INTO slms (slmId, slmName, password, hq, region, zone, teamName, tlmId, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [row.SLMID, row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, finalSlmTeamName, row.TLMID, adminId]
        );
      }

      // ==================== FLM ==================== //
      // Hierarchy: If FLM doesn't have teamName in Excel, inherit from SLM (top-down)
      const [flmRows] = await db.execute(
        "SELECT * FROM flms WHERE flmId = ?",
        [row.FLMID]
      );

      // Determine FLM's teamName: Excel value takes priority, otherwise inherit from SLM
      let finalFlmTeamName = null;
      if (isValidValue(flmTeamName)) {
        finalFlmTeamName = flmTeamName; // Excel value takes priority
      } else {
        // Try to inherit from SLM: first from current row's SLM, then from database
        if (isValidValue(finalSlmTeamName)) {
          finalFlmTeamName = finalSlmTeamName; // Inherit from SLM in current row (top-down)
        } else if (row.SLMID) {
          // If SLM didn't have teamName in Excel, check database for SLM's teamName
          const [slmCheckRows] = await db.execute(
            "SELECT teamName FROM slms WHERE slmId = ?",
            [row.SLMID]
          );
          if (slmCheckRows.length > 0 && isValidValue(slmCheckRows[0].teamName)) {
            finalFlmTeamName = slmCheckRows[0].teamName; // Inherit from SLM in database
          }
        }
      }

      if (flmRows.length > 0) {
        // Update teamName if we have a value (from Excel or inherited)
        if (isValidValue(finalFlmTeamName)) {
          // Commented out: points and currentDiceRollBalance - will be provided using new APIs
        await db.execute(
          `UPDATE flms
           SET flmName = ?,
               password = ?,
               hq = ?,
               region = ?,
               zone = ?,
               teamName = ?,
               adminId = ?,
                 updatedAt = NOW()
           WHERE flmId = ?`,
          [
            row.FLMNAME,
            row.FLMPASSWORD,
            row.FLMHQ,
            row.FLMREGION,
            row.FLMZONE,
              finalFlmTeamName,
            adminId,
            row.FLMID,
          ]
        );
      } else {
          // Skip teamName update if not provided and no inheritance
          // Commented out: points and currentDiceRollBalance - will be provided using new APIs
          await db.execute(
            `UPDATE flms
             SET flmName = ?,
                 password = ?,
                 hq = ?,
                 region = ?,
                 zone = ?,
                 adminId = ?,
                 updatedAt = NOW()
             WHERE flmId = ?`,
            [
              row.FLMNAME,
              row.FLMPASSWORD,
              row.FLMHQ,
              row.FLMREGION,
              row.FLMZONE,
              adminId,
              row.FLMID,
            ]
          );
        }
      } else {
        // For INSERT, use teamName if provided or inherited, otherwise null
        // Commented out: points and currentDiceRollBalance - will be provided using new APIs
        await db.execute(
          `INSERT INTO flms (flmId, FlmName, password, hq, region, zone, teamName, slmId, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            row.FLMID,
            row.FLMNAME,
            row.FLMPASSWORD,
            row.FLMHQ,
            row.FLMREGION,
            row.FLMZONE,
            finalFlmTeamName,
            row.SLMID,
            adminId,
          ]
        );
      }

      // ==================== MR ==================== //
      // Hierarchy: If MR doesn't have teamName in Excel, inherit from FLM (top-down)
      const [mrRows] = await db.execute(
        "SELECT * FROM mrs WHERE mrId = ?",
        [row.MRID]
      );

      const cleanDOJ = excelDateToJSDate(row.MRDOJ);

      // Determine MR's teamName: Excel value takes priority, otherwise inherit from FLM
      let finalMrTeamName = null;
      if (isValidValue(mrTeamName)) {
        finalMrTeamName = mrTeamName; // Excel value takes priority
      } else {
        // Try to inherit from FLM: first from current row's FLM, then from database
        if (isValidValue(finalFlmTeamName)) {
          finalMrTeamName = finalFlmTeamName; // Inherit from FLM in current row (top-down)
        } else if (row.FLMID) {
          // If FLM didn't have teamName in Excel, check database for FLM's teamName
          const [flmCheckRows] = await db.execute(
            "SELECT teamName FROM flms WHERE flmId = ?",
            [row.FLMID]
          );
          if (flmCheckRows.length > 0 && isValidValue(flmCheckRows[0].teamName)) {
            finalMrTeamName = flmCheckRows[0].teamName; // Inherit from FLM in database
          }
        }
      }

      if (mrRows.length > 0) {
        // Update teamName if we have a value (from Excel or inherited)
        if (isValidValue(finalMrTeamName)) {
        await db.execute(
            `UPDATE mrs SET mrName=?, email=?, password=?, role=?, hq=?, region=?, zone=?, businessUnit=?, dateOfJoining=?, teamName=?, adminId=?, updatedAt=NOW()
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
              finalMrTeamName,
            adminId,
            row.MRID,
          ]
        );
      } else {
          // Skip teamName update if not provided and no inheritance
          await db.execute(
            `UPDATE mrs SET mrName=?, email=?, password=?, role=?, hq=?, region=?, zone=?, businessUnit=?, dateOfJoining=?, adminId=?, updatedAt=NOW()
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
              adminId,
              row.MRID,
            ]
          );
        }
      } else {
        // For INSERT, use teamName if provided or inherited, otherwise null
        await db.execute(
          `INSERT INTO mrs (mrId, mrName, email, password, role, hq, region, zone, businessUnit, dateOfJoining, teamName, flmId, adminId, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
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
            finalMrTeamName,
            row.FLMID,
            adminId,
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
       SET f.mrCount = COALESCE(m.mrCount, 0), f.updatedAt = NOW()`
    );

    // Insert all FLM IDs into diceRolls table
    // Get all unique FLM IDs from the processed data
    const flmIds = [...new Set(data.map(row => row.FLMID).filter(id => id))];
    
    // Insert each FLM ID into diceRolls table (ignore if already exists due to UNIQUE constraint)
    for (const flmId of flmIds) {
      try {
        await db.execute(
          `INSERT IGNORE INTO diceRolls (playerId, diceValue, rolledAt, boardStatus, currentBoardId, teamName, activePlayerId)
           VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL)`,
          [flmId]
        );
      } catch (error) {
        // If insert fails (e.g., foreign key constraint), log but continue
        console.error(`Error inserting FLM ${flmId} into diceRolls:`, error.message);
      }
    }

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
  }
};


//myist
// export const handleExcelSheetUpload = async (req, res) => {
//   try {
//     const adminId = req.query.adminId;
    // const istDateTimeString = formatISTDateTimeForSQL();

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

//     const [configRows] = await db.execute(
//       `SELECT pointToDiceRollRatio
//        FROM config
//        WHERE pointToDiceRollRatio IS NOT NULL
//        ORDER BY createdAt DESC
//        LIMIT 1`
//     );

//     const pointToDiceRollRatio = Number(configRows?.[0]?.pointToDiceRollRatio) || 1;
//     const defaultPoints = 100;
//     const defaultMoves = defaultPoints * pointToDiceRollRatio;

//     for (const row of data) {
//       // Get teamName from Excel (handle case variations)
//       const teamName = row.TEAMNAME || row.TeamName || row.teamName || row['Team Name'] || null;

//       // ==================== TLM ==================== //
//       const [tlmRows] = await db.execute(
//         "SELECT * FROM tlms WHERE tlmId = ?",
//         [row.TLMID]
//       );

//       if (tlmRows.length > 0) {
//         await db.execute(
//           `UPDATE tlms SET tlmName=?, password=?, hq=?, zone=?, teamName=?, adminId=?, updatedAt=? WHERE tlmId=?`,
//           [row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, teamName, adminId, istDateTimeString, row.TLMID]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO tlms (tlmId, tlmName, password, hq, zone, teamName, adminId, createdAt, updatedAt)
//            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//           [row.TLMID, row.TLMNAME, row.TLMPASSWORD, row.TLMHQ, row.TLMZONE, teamName, adminId, istDateTimeString, istDateTimeString]
//         );
//       }

//       // ==================== SLM ==================== //
//       const [slmRows] = await db.execute(
//         "SELECT * FROM slms WHERE slmId = ?",
//         [row.SLMID]
//       );

//       if (slmRows.length > 0) {
//         await db.execute(
//           `UPDATE slms SET slmName=?, password=?, hq=?, region=?, zone=?, teamName=?, adminId=?, updatedAt=? WHERE slmId=?`,
//           [row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, teamName, adminId, istDateTimeString, row.SLMID]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO slms (slmId, slmName, password, hq, region, zone, teamName, tlmId, adminId, createdAt, updatedAt)
//            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//           [row.SLMID, row.SLMNAME, row.SLMPASSWORD, row.SLMHQ, row.SLMREGION, row.SLMZONE, teamName, row.TLMID, adminId, istDateTimeString, istDateTimeString]
//         );
//       }

//       // ==================== FLM ==================== //
//       const [flmRows] = await db.execute(
//         "SELECT * FROM flms WHERE flmId = ?",
//         [row.FLMID]
//       );

//       if (flmRows.length > 0) {
//         await db.execute(
//           `UPDATE flms
//            SET flmName = ?,
//                password = ?,
//                hq = ?,
//                region = ?,
//                zone = ?,
//                teamName = ?,
//                points = ?,
//                currentDiceRollBalance = ?,
//                adminId = ?,
//                updatedAt = ?
//            WHERE flmId = ?`,
//           [
//             row.FLMNAME,
//             row.FLMPASSWORD,
//             row.FLMHQ,
//             row.FLMREGION,
//             row.FLMZONE,
//             teamName,
//             defaultPoints,
//             defaultMoves,
//             adminId,
//             istDateTimeString,
//             row.FLMID,
//           ]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO flms (flmId, FlmName, password, hq, region, zone, teamName, slmId, points, currentDiceRollBalance, adminId, createdAt, updatedAt)
//            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
//           [
//             row.FLMID,
//             row.FLMNAME,
//             row.FLMPASSWORD,
//             row.FLMHQ,
//             row.FLMREGION,
//             row.FLMZONE,
//             teamName,
//             row.SLMID,
//             defaultPoints,
//             defaultMoves,
//             adminId,
//             istDateTimeString,
//             istDateTimeString,
//           ]
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
//           `UPDATE mrs SET mrName=?, email=?, password=?, role=?, hq=?, region=?, zone=?, businessUnit=?, dateOfJoining=?, teamName=?, adminId=?, updatedAt=?
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
//             teamName,
//             adminId,
//             istDateTimeString,
//             row.MRID,
//           ]
//         );
//       } else {
//         await db.execute(
//           `INSERT INTO mrs (mrId, mrName, email, password, role, hq, region, zone, businessUnit, dateOfJoining, teamName, flmId, adminId, createdAt, updatedAt)
//            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
//             teamName,
//             row.FLMID,
//             adminId,
//             istDateTimeString,
//             istDateTimeString,
//           ]
//         );
//       }
//     }

//     const updatedAtIST = formatISTDateTimeForSQL();
//     await db.execute(
//       `UPDATE flms f
//        LEFT JOIN (
//          SELECT flmId, COUNT(*) AS mrCount
//          FROM mrs
//          WHERE flmId IS NOT NULL
//          GROUP BY flmId
//        ) m ON f.flmId = m.flmId
//        SET f.mrCount = COALESCE(m.mrCount, 0), f.updatedAt = ?`,
//       [updatedAtIST]
//     );

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
