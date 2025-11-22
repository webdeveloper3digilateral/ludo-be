CREATE TABLE `adminPoints` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `adminId` varchar(36) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `userType` enum('flm','mr','slm','tlm') NOT NULL,
  `points` int NOT NULL,
  `reason` text DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `adminId` (`adminId`),
  KEY `userId` (`userId`),
  KEY `userType` (`userType`),
  KEY `createdAt` (`createdAt`),
  CONSTRAINT `adminPoints_ibfk_1` FOREIGN KEY (`adminId`) REFERENCES `admins` (`adminId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

