CREATE TABLE `brands` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `brandName` varchar(255) NOT NULL,
  `points` int DEFAULT NULL,
  `defaultRxnDuration` int DEFAULT 1,
  `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `brandName` (`brandName`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci