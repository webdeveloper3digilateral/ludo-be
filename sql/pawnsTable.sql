CREATE TABLE `pawns` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `boardId` int NOT NULL,
  `playerId` varchar(36) NOT NULL,
  `type` enum('main','base','home','center') DEFAULT NULL,
  `color` enum('red','blue','green','yellow') DEFAULT NULL,
  `prevPosition` varchar(36) DEFAULT '-1',
  `currentPosition` varchar(36) DEFAULT '0',
  `isSafe` tinyint(1) DEFAULT '0',
  `moves` int DEFAULT '0',
  `kills` int DEFAULT '0',
  `hasHeart` tinyint(1) DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `boardId` (`boardId`),
  KEY `playerId` (`playerId`),
  CONSTRAINT `pawns_ibfk_1` FOREIGN KEY (`boardId`) REFERENCES `boards` (`id`),
  CONSTRAINT `pawns_ibfk_2` FOREIGN KEY (`playerId`) REFERENCES `flms` (`flmId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci


-- CREATE TABLE `pawns` (
--   `id` varchar(36) NOT NULL DEFAULT (uuid()),
--   `boardId` int NOT NULL,
--   `playerId` varchar(36) NOT NULL,
--   `type` enum('main','base','home','center') DEFAULT NULL,
--   `color` enum('red','blue','green','yellow') DEFAULT NULL,
--   `prevPosition` varchar(36) DEFAULT '-1',
--   `currentPosition` varchar(36) DEFAULT NULL,
--   `isSafe` tinyint(1) DEFAULT '0',
--   `moves` int DEFAULT '0',
--   PRIMARY KEY (`id`),
--   KEY `boardId` (`boardId`),
--   KEY `playerId` (`playerId`),
--   CONSTRAINT `pawns_ibfk_1` FOREIGN KEY (`boardId`) REFERENCES `boards` (`id`),
--   CONSTRAINT `pawns_ibfk_2` FOREIGN KEY (`playerId`) REFERENCES `flms` (`flmId`)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci


