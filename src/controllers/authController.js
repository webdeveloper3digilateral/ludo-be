import db from "../config/db.js";
import jwt from "jsonwebtoken";

export const loginUser = async (req, res) => {
  const { userId, password } = req.body;

  if (!userId || !password) {
    return res.status(400).json({ message: "User ID and password are required" });
  }

  try {
    // Tables to check in order
    const tables = [
      { name: "admins", id: "adminId", pass: "password", role: "Admin" },
      { name: "tlms", id: "tlmId", pass: "password", role: "TLM" },
      { name: "slms", id: "slmId", pass: "password", role: "SLM" },
      { name: "flms", id: "flmId", pass: "password", role: "FLM" },
      { name: "mrs", id: "mrId", pass: "password", role: "MR" },
    ];

    let foundUser = null;
    let userRole = null;

    for (const t of tables) {
      const [rows] = await db.execute(
        `SELECT * FROM ${t.name} WHERE ${t.id} = ?`,
        [userId]
      );

      if (rows.length > 0) {
        foundUser = rows[0];
        userRole = t.role;
        break;
      }
    }

    if (!foundUser) {
      return res.status(404).json({ message: "User not found in any table" });
    }

    const isPasswordCorrect = password === foundUser.password;

    if (!isPasswordCorrect) {
      return res.status(401).json({ message: "Invalid password" });
    }

    // ✅ Generate JWT token
    const token = jwt.sign(
      {
        id: foundUser.userId || foundUser.adminId || foundUser.tlmId || foundUser.slmId || foundUser.flmId || foundUser.mrId,
        role: userRole,
      },
      process.env.JWT_SECRET || "supersecretkey",
      { expiresIn: "7d" }
    );

    const fetchActiveBoardForPlayer = async playerId => {
      try {
        const [boardRows] = await db.execute(
          `SELECT id FROM boards 
           WHERE status = 'active' 
             AND (player1 = ? OR player2 = ? OR player3 = ? OR player4 = ?)
           ORDER BY startTime DESC, id DESC
           LIMIT 1`,
          [playerId, playerId, playerId, playerId]
        );

        if (boardRows.length > 0) {
          const board = boardRows[0];
          const [colorRows] = await db.execute(
            `SELECT color FROM pawns 
             WHERE boardId = ? AND playerId = ? 
             LIMIT 1`,
            [board.id, playerId]
          );

          return {
            boardId: board.id,
            myColor: colorRows.length > 0 ? colorRows[0].color : null,
          };
        }
      } catch (boardError) {
        console.error("Error fetching current board:", boardError);
      }

      return null;
    };

    let currentBoard = null;
    if (userRole === "FLM") {
      currentBoard = await fetchActiveBoardForPlayer(userId);
    } else if (userRole === "MR") {
      if (foundUser.flmId) {
        currentBoard = await fetchActiveBoardForPlayer(foundUser.flmId);
      }
    }

    res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: userId,
        name: foundUser.name || foundUser.tlmName || foundUser.slmName || foundUser.flmName || foundUser.mrName,
        role: userRole,
      },
      ...(currentBoard ? { currentBoard: currentBoard } : {}),
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};
