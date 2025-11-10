CREATE TABLE `moveLogs` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `boardId` varchar(36) NOT NULL,
  `playerId` varchar(255) NOT NULL,
  `pawnId` varchar(36) NOT NULL,
  `diceValue` int DEFAULT NULL,
  `prevPos` varchar(50) NOT NULL,
  `nextPos` varchar(50) NOT NULL,
  `hasCaptured` tinyint(1) DEFAULT '0',
  `gotCaptured` tinyint(1) DEFAULT '0',
  `moveTime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_board` (`boardId`),
  KEY `idx_player` (`playerId`),
  KEY `idx_pawn` (`pawnId`),
  KEY `idx_moveTime` (`moveTime` DESC),
  KEY `filter1` (`boardId`,`pawnId`,`moveTime` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci