-- CREATE TABLE `brands` (
--   `id` varchar(36) NOT NULL DEFAULT (uuid()),
--   `brandName` varchar(255) NOT NULL,
--   `points` int DEFAULT NULL,
--   `defaultRxnDuration` int DEFAULT '1',
--   `countType` enum('unit','value') DEFAULT NULL,
--   `unitFactor` int DEFAULT NULL,
--   `valueFactor` int DEFAULT NULL,
--   `diamonds` int DEFAULT NULL,
--   `diceRolls` int DEFAULT NULL,
--   `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
--   `updatedAt` datetime DEFAULT CURRENT_TIMESTAMP,
--   PRIMARY KEY (`id`),
--   UNIQUE KEY `brandName` (`brandName`)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci


CREATE TABLE `brands` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `brandName` varchar(255) NOT NULL,
  `points` int DEFAULT NULL,
  `diamonds` int DEFAULT NULL,
  `diceRolls` int DEFAULT '0',
  `defaultRxnDuration` int DEFAULT '1',
  `countType` enum('unit','value') DEFAULT NULL,
  `unitFactor` int DEFAULT NULL,
  `valueFactor` int DEFAULT NULL,
  `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `brandName` (`brandName`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci