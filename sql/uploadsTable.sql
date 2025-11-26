CREATE TABLE `uploads` (
  `id` varchar(36) NOT NULL DEFAULT (uuid()),
  `type` varchar(255) NOT NULL,
  `mrId` varchar(255) NOT NULL,
  `uploadImage` varchar(500) DEFAULT NULL,
  `dateOfUpload` date NOT NULL,
  `timeOfUpload` time DEFAULT NULL,
  `status` enum('pending','approved','rejected') DEFAULT 'approved',
  `reason` text DEFAULT NULL,
  `attempts` int DEFAULT '0',
  `reviewDate` datetime DEFAULT NULL,
  `points` int DEFAULT '0',
  `diceRollBalance` int DEFAULT '0',
  `isCalculated` tinyint(1) DEFAULT '0',
  `activitySpecificDetails` json DEFAULT NULL,
  `drName` varchar(255) DEFAULT NULL,
  `speciality` varchar(255) DEFAULT NULL,
  `mobNo` varchar(20) DEFAULT NULL,
  `scCode` varchar(255) DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `fk_upload_mr` (`mrId`),
  KEY `idx_dateOfUpload` (`dateOfUpload`),
  KEY `idx_type` (`type`),
  KEY `idx_status` (`status`),
  CONSTRAINT `fk_upload_mr` FOREIGN KEY (`mrId`) REFERENCES `mrs` (`mrId`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci

-- CREATE TABLE `uploads` (
--   `id` varchar(36) NOT NULL DEFAULT (uuid()),
--   `type` enum('prescription','pob','camp') NOT NULL,
--   `mrId` varchar(255) NOT NULL,

--   -- Common fields
--   `uploadImage` varchar(500) DEFAULT NULL,
--   `dateOfUpload` date NOT NULL,
--   `timeOfUpload` time DEFAULT NULL,
--   `status` enum('pending','approved','rejected') DEFAULT 'pending',
--   `rejectionReason` text,
--   `attempts` int DEFAULT '0',
--   `reviewDate` datetime DEFAULT NULL,
--   `points` int DEFAULT '0',
--   `diceRollBalance` int DEFAULT '0',
--   `isCalculated` tinyint(1) DEFAULT '0',

--   -- For Prescription and POB: brand reference
--   `brandId` varchar(36) DEFAULT NULL,
--   `brandName` varchar(255) DEFAULT NULL,

--   -- For Camp: camp reference
--   `campId` varchar(36) DEFAULT NULL,
--   `campName` varchar(255) DEFAULT NULL,

--   -- MCL field (used in Prescription and POB)
--   `drName` varchar(255) DEFAULT NULL,
--   `speciality` varchar(255) DEFAULT NULL,
--   `mobNo` varchar(20) DEFAULT NULL,
--   `scCode` varchar(255) DEFAULT NULL,
--   `noRxns` int DEFAULT NULL,
--   `rxnDuration` int DEFAULT NULL,

--   -- For POB: chemist reference
--   `chemistName` varchar(255) DEFAULT NULL,
--   `noOfUnits` int DEFAULT NULL,
--   `allValue` int DEFAULT NULL,

--   -- For Camp: number of camps and default factor
--   `noOfCamps` int DEFAULT NULL,
--   `campDefaultFactor` int DEFAULT NULL,
--   `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
--   `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
--   PRIMARY KEY (`id`),
--   KEY `fk_upload_mr` (`mrId`),
--   KEY `fk_upload_brand` (`brandId`),
--   KEY `fk_upload_camp` (`campId`),
--   KEY `idx_dateOfUpload` (`dateOfUpload`),
--   KEY `idx_type` (`type`),
--   KEY `idx_status` (`status`),
--   CONSTRAINT `fk_upload_brand` FOREIGN KEY (`brandId`) REFERENCES `brands` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
--   CONSTRAINT `fk_upload_camp` FOREIGN KEY (`campId`) REFERENCES `camps` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
--   CONSTRAINT `fk_upload_mr` FOREIGN KEY (`mrId`) REFERENCES `mrs` (`mrId`) ON DELETE CASCADE ON UPDATE CASCADE
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci



-- --24-11
-- CREATE TABLE `uploads` (
--   `id` varchar(36) NOT NULL DEFAULT (uuid()),
--   `type` enum('prescription','pob','camp') NOT NULL,
--   `mrId` varchar(255) NOT NULL,
--   `uploadImage` varchar(500) DEFAULT NULL,
--   `dateOfUpload` date NOT NULL,
--   `timeOfUpload` time DEFAULT NULL,
--   `status` enum('pending','approved','rejected') DEFAULT 'pending',
--   `rejectionReason` text,
--   `attempts` int DEFAULT '0',
--   `reviewDate` datetime DEFAULT NULL,
--   `points` int DEFAULT '0',
--   `diceRollBalance` int DEFAULT '0',
--   `isCalculated` tinyint(1) DEFAULT '0',
--   `brandId` varchar(36) DEFAULT NULL,
--   `brandName` varchar(255) DEFAULT NULL,
--   `campId` varchar(36) DEFAULT NULL,
--   `campName` varchar(255) DEFAULT NULL,
--   `drName` varchar(255) DEFAULT NULL,
--   `speciality` varchar(255) DEFAULT NULL,
--   `mobNo` varchar(20) DEFAULT NULL,
--   `scCode` varchar(255) DEFAULT NULL,
--   `noRxns` int DEFAULT NULL,
--   `rxnDuration` int DEFAULT NULL,
--   `chemistName` varchar(255) DEFAULT NULL,
--   `noOfUnits` int DEFAULT NULL,
--   `allValue` int DEFAULT NULL,
--   `noOfCamps` int DEFAULT NULL,
--   `campDefaultFactor` int DEFAULT NULL,
--   `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
--   `updatedAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
--   PRIMARY KEY (`id`),
--   KEY `fk_upload_mr` (`mrId`),
--   KEY `fk_upload_brand` (`brandId`),
--   KEY `fk_upload_camp` (`campId`),
--   KEY `idx_dateOfUpload` (`dateOfUpload`),
--   KEY `idx_type` (`type`),
--   KEY `idx_status` (`status`),
--   CONSTRAINT `fk_upload_brand` FOREIGN KEY (`brandId`) REFERENCES `brands` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
--   CONSTRAINT `fk_upload_camp` FOREIGN KEY (`campId`) REFERENCES `camps` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
--   CONSTRAINT `fk_upload_mr` FOREIGN KEY (`mrId`) REFERENCES `mrs` (`mrId`) ON DELETE CASCADE ON UPDATE CASCADE
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci