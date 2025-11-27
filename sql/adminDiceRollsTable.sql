CREATE TABLE `adminDiceRolls` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `adminId` varchar(36) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `userType` enum('flm','mr','slm','tlm') NOT NULL,
  `diceRolls` int NOT NULL,
  `previousBalance` int DEFAULT NULL,
  `newBalance` int DEFAULT NULL,
  `reason` text,
  `mode` enum('player','role') NOT NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `adminId` (`adminId`),
  KEY `userId` (`userId`),
  KEY `userType` (`userType`),
  KEY `createdAt` (`createdAt`),
  CONSTRAINT `adminDiceRolls_ibfk_1` FOREIGN KEY (`adminId`) REFERENCES `admins` (`adminId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci