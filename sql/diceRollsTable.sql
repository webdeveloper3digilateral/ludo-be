CREATE TABLE `diceRolls` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `playerId` varchar(255) NOT NULL,
  `diceValue` int DEFAULT NULL,
  `rolledAt` timestamp(3) NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `currentBoardId` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `playerId` (`playerId`),
  KEY `idx_rolledAt` (`rolledAt` DESC),
  CONSTRAINT `fk_diceRolls_flm` FOREIGN KEY (`playerId`) REFERENCES `flms` (`flmId`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci