import db from "../config/db.js";

let ioInstance = null;

export const setupSocketHandlers = (io) => {
  ioInstance = io;

  io.on("connection", (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Join a board room
    socket.on("join_board", async (data) => {
      try {
        const { boardId, playerId } = data;

        if (!boardId) {
          socket.emit("error", { message: "Board ID is required" });
          return;
        }

        // Verify board exists
        const connection = await db.getConnection();
        try {
          const [boardRows] = await connection.execute(
            `SELECT * FROM boards WHERE id = ?`,
            [boardId]
          );

          if (boardRows.length === 0) {
            socket.emit("error", { message: "Board not found" });
            return;
          }

          // Join the board room
          socket.join(`board:${boardId}`);
          console.log(`✅ Socket ${socket.id} joined board: ${boardId}`);

          // Notify others in the room
          socket.to(`board:${boardId}`).emit("player_joined", {
            playerId,
            socketId: socket.id,
          });

          // Send current board state to the new player
          const [pawns] = await connection.execute(
            `SELECT * FROM pawns WHERE boardId = ? ORDER BY playerId, id`,
            [boardId]
          );

          socket.emit("board_state", {
            success: true,
            data: { pawns },
          });
        } finally {
          connection.release();
        }
      } catch (error) {
        console.error("Error joining board:", error);
        socket.emit("error", { message: "Failed to join board" });
      }
    });

    // Leave a board room
    socket.on("leave_board", (data) => {
      const { boardId } = data;
      if (boardId) {
        socket.leave(`board:${boardId}`);
        console.log(`❌ Socket ${socket.id} left board: ${boardId}`);
      }
    });

    // // Handle dice roll (optional - can be used for real-time dice)
    // socket.on("dice_roll", (data) => {
    //   const { boardId, playerId, diceNumber } = data;
    //   if (boardId && playerId) {
    //     socket.to(`board:${boardId}`).emit("dice_rolled", {
    //       playerId,
    //       diceNumber,
    //     });
    //   }
    // });

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });
};


// Function to emit board state update to all clients in a board room
export const emitBoardUpdate = async (boardId, payload = {}) => {
  if (!ioInstance) return;

  const { pawns: providedPawns, ...rest } = payload;
  let pawns = providedPawns;
  let connection = null;

  try {
    if (!pawns) {
      connection = await db.getConnection();
      const [rows] = await connection.execute(
        `SELECT * FROM pawns WHERE boardId = ? ORDER BY playerId, id`,
        [boardId]
      );
      pawns = rows;
    }

    ioInstance.to(`board:${boardId}`).emit("board_update", {
      success: true,
      data: {
        pawns,
        ...rest,
      },
    });
  } catch (error) {
    console.error("Error emitting board update:", error);
  } finally {
    if (connection) connection.release();
  }
};

// Function to emit game event (winner, game end, etc.)
export const emitGameEvent = (boardId, eventType, eventData) => {
  if (ioInstance) {
    ioInstance.to(`board:${boardId}`).emit("game_event", {
      type: eventType,
      data: eventData,
    });
  }
};


// Function to emit pawn move to all clients in a board room
export const emitPawnMove = (boardId, pawnData) => {
  if (ioInstance) {
    ioInstance.to(`board:${boardId}`).emit("pawn_moved", {
      success: true,
      pawn: pawnData,
    });
  }
};


// Function to emit pawn killed event
export const emitPawnKilled = (boardId, killedPawnData, killedBy) => {
  if (ioInstance) {
    ioInstance.to(`board:${boardId}`).emit("pawn_killed", {
      success: true,
      killedPawn: killedPawnData,
      killedBy: killedBy,
      message: `Pawn was sent back to base!`,
    });
  }
};

