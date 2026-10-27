# AWS reference infra (ap-south-1 primary, ap-southeast-1 DR). Illustrative skeleton: `terraform validate`-able structure, adjust CIDRs/sizing.
terraform {
  required_version = ">= 1.6"
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.60" } }
}
variable "region"    { default = "ap-south-1" }
variable "dr_region" { default = "ap-southeast-1" }
variable "env"       { default = "prod" }
provider "aws" { region = var.region }
provider "aws" { alias = "dr" region = var.dr_region }

module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  name = "amrutam-${var.env}"
  cidr = "10.20.0.0/16"
  azs = ["${var.region}a", "${var.region}b", "${var.region}c"]
  private_subnets  = ["10.20.1.0/24", "10.20.2.0/24", "10.20.3.0/24"]
  public_subnets   = ["10.20.101.0/24", "10.20.102.0/24", "10.20.103.0/24"]
  database_subnets = ["10.20.201.0/24", "10.20.202.0/24", "10.20.203.0/24"]
  enable_nat_gateway = true
}

resource "aws_kms_key" "data" { description = "amrutam data-at-rest + envelope root key" enable_key_rotation = true deletion_window_in_days = 30 }

# PostgreSQL: Multi-AZ (99.95% target), encrypted, PITR, read replica for analytics/search
resource "aws_db_instance" "primary" {
  identifier = "amrutam-${var.env}"
  engine = "postgres" engine_version = "16"
  instance_class = "db.r6g.xlarge" allocated_storage = 200 max_allocated_storage = 1000
  multi_az = true storage_encrypted = true kms_key_id = aws_kms_key.data.arn
  backup_retention_period = 14 backup_window = "21:00-22:00" copy_tags_to_snapshot = true deletion_protection = true
  db_subnet_group_name = module.vpc.database_subnet_group_name
  manage_master_user_password = true            # password lives in Secrets Manager, never in state/code
  performance_insights_enabled = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  username = "amrutam"
}
resource "aws_db_instance" "read_replica" {
  identifier = "amrutam-${var.env}-ro" replicate_source_db = aws_db_instance.primary.identifier
  instance_class = "db.r6g.large" storage_encrypted = true kms_key_id = aws_kms_key.data.arn
}
# Cross-region DR: automated backups replicated to DR region (RPO ~5 min via PITR + WAL shipping)
resource "aws_db_instance_automated_backups_replication" "dr" {
  provider = aws.dr
  source_db_instance_arn = aws_db_instance.primary.arn
  retention_period = 7
  kms_key_id = "alias/aws/rds"
}
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "amrutam-${var.env}" description = "cache"
  engine = "redis" node_type = "cache.r6g.large" num_cache_clusters = 2 automatic_failover_enabled = true multi_az_enabled = true
  at_rest_encryption_enabled = true transit_encryption_enabled = true
  subnet_group_name = module.vpc.elasticache_subnet_group_name
}
resource "aws_secretsmanager_secret" "app" { name = "amrutam/${var.env}/app" kms_key_id = aws_kms_key.data.arn }  # JWT_SECRET, ENCRYPTION_KEYRING (rotation lambda)
resource "aws_wafv2_web_acl" "api" {
  name = "amrutam-api" scope = "REGIONAL"
  default_action { allow {} }
  rule { name = "aws-managed-common" priority = 1
    override_action { none {} }
    statement { managed_rule_group_statement { name = "AWSManagedRulesCommonRuleSet" vendor_name = "AWS" } }
    visibility_config { cloudwatch_metrics_enabled = true metric_name = "common" sampled_requests_enabled = true } }
  visibility_config { cloudwatch_metrics_enabled = true metric_name = "api" sampled_requests_enabled = true }
}
resource "aws_s3_bucket" "audit_archive" { bucket = "amrutam-${var.env}-audit-archive" object_lock_enabled = true }  # WORM storage for archived audit partitions
resource "aws_s3_bucket_server_side_encryption_configuration" "audit" {
  bucket = aws_s3_bucket.audit_archive.id
  rule { apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" kms_master_key_id = aws_kms_key.data.arn } }
}
# EKS cluster, ALB ingress, and ECR omitted for brevity: use terraform-aws-modules/eks; manifests in infra/k8s.
